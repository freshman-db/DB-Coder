/**
 * MaintenancePhase — Non-LLM verification, branch cleanup, locking, health checks.
 *
 * Methods extracted from MainLoop:
 * - hardVerify, checkBudgetOrAbort
 * - cleanupOrphanedBranches, cleanupTaskBranch
 * - claudeMdMaintenance, pipelineHealthCheck
 * - isSelfProject, writeBuildError
 * - acquireLock, releaseLock
 * - countTscErrors, setCountTscErrorsDepsForTests
 */

import type { Config } from "../../config/Config.js";
import { resolveModelId } from "../../config/Config.js";
import type { TaskStore } from "../../memory/TaskStore.js";
import type { CostTracker } from "../../utils/cost.js";
import type { ClaudeCodeSession } from "../../bridges/ClaudeCodeSession.js";
import type { ProjectVerifier, VerifyBaseline } from "../ProjectVerifier.js";
import {
  getDiffStats,
  listBranches,
  branchExists,
  forceDeleteBranch,
  getBranchHeadCommit,
} from "../../utils/git.js";
import { log } from "../../utils/logger.js";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// cleanupTaskBranch — DI seam for testing
// ---------------------------------------------------------------------------

type CleanupBranchDeps = {
  forceDeleteBranch: (branch: string, cwd: string) => Promise<void>;
  getBranchHeadCommit: (branch: string, cwd: string) => Promise<string>;
};

const defaultCleanupBranchDeps: CleanupBranchDeps = {
  forceDeleteBranch,
  getBranchHeadCommit,
};

let cleanupBranchDeps: CleanupBranchDeps = defaultCleanupBranchDeps;

export function setCleanupBranchDepsForTests(
  overrides?: Partial<CleanupBranchDeps>,
): void {
  cleanupBranchDeps = overrides
    ? { ...defaultCleanupBranchDeps, ...overrides }
    : defaultCleanupBranchDeps;
}

// ---------------------------------------------------------------------------
// countTscErrors — DI seam for testing
// ---------------------------------------------------------------------------

type RunProcessFn = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    input?: string;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type CountTscErrorsDeps = {
  existsSync: (path: string) => boolean;
  runProcess: RunProcessFn;
};

const defaultCountTscErrorsDeps: CountTscErrorsDeps = {
  existsSync,
  runProcess: async (command, args, options) => {
    const { runProcess } = await import("../../utils/process.js");
    return runProcess(command, args, options);
  },
};

let countTscErrorsDeps: CountTscErrorsDeps = defaultCountTscErrorsDeps;

export function setCountTscErrorsDepsForTests(
  overrides?: Partial<CountTscErrorsDeps>,
): void {
  countTscErrorsDeps = overrides
    ? { ...defaultCountTscErrorsDeps, ...overrides }
    : defaultCountTscErrorsDeps;
}

export async function countTscErrors(cwd: string): Promise<number> {
  if (!countTscErrorsDeps.existsSync(join(cwd, "tsconfig.json"))) return 0;
  try {
    const result = await countTscErrorsDeps.runProcess(
      "npx",
      ["tsc", "--noEmit"],
      { cwd, timeout: 60_000 },
    );
    return (result.stdout + result.stderr)
      .split("\n")
      .filter((l) => l.includes(": error TS")).length;
  } catch (e) {
    log.warn("countTscErrors failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return -1;
  }
}

// ---------------------------------------------------------------------------
// MaintenancePhase class
// ---------------------------------------------------------------------------

export class MaintenancePhase {
  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly brainSession: ClaudeCodeSession,
    private readonly projectVerifier: ProjectVerifier,
    private readonly lockFile: string,
  ) {}

  // --- Hard verification (zero LLM cost) ---

  async hardVerify(
    baseline: VerifyBaseline,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    // 1. Type check + tests via ProjectVerifier
    const result = await this.projectVerifier.verify(projectPath, baseline);
    if (!result.passed) {
      return { passed: false, reason: result.reason };
    }

    // 2. Diff anomaly check (warn only)
    try {
      const stats = await getDiffStats(startCommit, "HEAD", projectPath);
      if (stats.files_changed > 15) {
        log.warn(
          `Post-check warning: ${stats.files_changed} files changed (${stats.insertions}+ ${stats.deletions}-)`,
        );
      }
    } catch {
      /* non-critical */
    }

    return { passed: true };
  }

  // --- Budget check ---

  async checkBudgetOrAbort(taskId: string): Promise<boolean> {
    const budget = await this.costTracker.checkBudget(taskId);
    if (budget.allowed) return false;
    log.warn(`Budget exceeded: ${budget.reason}`);
    await this.taskStore.updateTask(taskId, {
      status: "blocked",
      phase: "blocked",
    });
    return true;
  }

  // --- Branch cleanup ---

  async cleanupOrphanedBranches(): Promise<void> {
    const projectPath = this.config.projectPath;
    const prefix = this.config.values.git.branchPrefix;
    const branches = await listBranches(prefix, projectPath);
    if (branches.length === 0) return;

    const [queued, active, failed, blocked] = await Promise.all([
      this.taskStore.listTasks(projectPath, "queued"),
      this.taskStore.listTasks(projectPath, "active"),
      this.taskStore.listTasks(projectPath, "failed"),
      this.taskStore.listTasks(projectPath, "blocked"),
    ]);

    // queued/active branches are always protected
    const activeBranches = new Set(
      [...queued, ...active].map((t) => t.git_branch).filter(Boolean),
    );

    // failed/blocked branches are protected within retention period
    const retentionMs =
      this.config.values.git.branchRetentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const retainedBranches = new Set(
      [...failed, ...blocked]
        .filter(
          (t) =>
            t.git_branch &&
            now - new Date(t.updated_at).getTime() < retentionMs,
        )
        .map((t) => t.git_branch),
    );

    let cleaned = 0;
    let preserved = 0;
    for (const branch of branches) {
      if (activeBranches.has(branch)) continue;
      if (retainedBranches.has(branch)) {
        preserved++;
        continue;
      }
      await this.cleanupTaskBranch(branch, { force: true });
      const stillExists = await branchExists(branch, projectPath).catch(
        () => true,
      );
      if (!stillExists) cleaned++;
    }
    if (preserved > 0)
      log.info(
        `Preserved ${preserved} branch(es) for recent failed/blocked tasks`,
      );
    if (cleaned > 0) log.info(`Cleaned up ${cleaned} orphaned branch(es)`);
  }

  async cleanupTaskBranch(
    branch: string,
    opts?: { force?: boolean; startCommit?: string },
  ): Promise<void> {
    try {
      if (opts?.force) {
        await cleanupBranchDeps.forceDeleteBranch(
          branch,
          this.config.projectPath,
        );
        return;
      }
      // Compare branch HEAD with startCommit: identical means no worker output
      if (opts?.startCommit) {
        const branchHead = await cleanupBranchDeps.getBranchHeadCommit(
          branch,
          this.config.projectPath,
        );
        if (branchHead === opts.startCommit) {
          await cleanupBranchDeps.forceDeleteBranch(
            branch,
            this.config.projectPath,
          );
          return;
        }
      }
      // Has worker output or cannot determine → preserve
      log.info(`Preserving branch ${branch} (has worker commits)`);
    } catch (err) {
      log.warn(`Failed to cleanup branch ${branch}: ${err}`);
    }
  }

  // --- Pipeline health check ---

  async pipelineHealthCheck(projectPath: string): Promise<void> {
    log.info("Pipeline health check triggered after consecutive rejections");

    const result = await this.brainSession.run(
      `## Pipeline Health Check

Multiple tasks have been rejected consecutively, suggesting a systemic pipeline issue.

## Instructions
1. Use the \`get_blocked_summary\` MCP tool to see how many tasks are blocked and their failure patterns
2. If blocked count < 3, respond "No systemic issue" and stop
3. Otherwise, use \`get_task_logs\` on a few failed tasks to understand the failure pattern
4. Use Read, Grep, Bash to investigate the pipeline code if failures point to a code bug
5. If you find a systemic bug, use \`create_task\` to create fix task(s) with:
   - Description prefixed with "[PIPELINE-FIX]"
   - Priority 0 (urgent)
6. Use \`requeue_blocked_tasks\` if blocked tasks should be retried after the fix
7. If failures are legitimate (bad task quality, not a bug), do nothing`,
      {
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        cwd: projectPath,
        timeout: 600_000,
        model: resolveModelId(this.config.values.brain.model),
        thinking: { type: "adaptive" },
        effort: "medium",
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "Bash",
          "mcp__db-coder-system-data__get_blocked_summary",
          "mcp__db-coder-system-data__get_recent_tasks",
          "mcp__db-coder-system-data__get_task_detail",
          "mcp__db-coder-system-data__get_task_logs",
          "mcp__db-coder-system-data__get_operational_metrics",
          "mcp__db-coder-system-data__create_task",
          "mcp__db-coder-system-data__requeue_blocked_tasks",
        ],
        appendSystemPrompt:
          "You are diagnosing pipeline failures. Investigate thoroughly before taking action. Do not modify source files.",
      },
    );

    if (result.costUsd > 0) {
      await this.taskStore.addDailyCost(result.costUsd);
    }
    log.info(
      `Pipeline health check completed (cost: $${result.costUsd.toFixed(3)})`,
    );
  }

  // --- CLAUDE.md maintenance ---

  async claudeMdMaintenance(projectPath: string): Promise<void> {
    log.info("Starting periodic CLAUDE.md maintenance");
    const result = await this.brainSession.run(
      `Perform a maintenance audit of CLAUDE.md. Keep it accurate, concise, and useful.

Read CLAUDE.md, then verify against actual code:
1. **文件结构** — Are listed files still accurate? Remove deleted, add important new ones.
2. **当前状态** — Are checklist items correct? Update "待运行验证" items if now verified.
3. **API 端点** — Do endpoints match actual routes in src/server/routes.ts?
4. **架构描述** — Does it match actual code structure?
5. **踩过的坑** — Remove entries for deleted code. Keep entries concise.
6. **DB Schema** — Are table descriptions still accurate?

Rules:
- DELETE outdated info rather than adding disclaimers.
- Keep the file concise — summarize growing sections.
- Only state what you verify in the code.
- Use claude-mem to note what you changed and why.`,
      {
        permissionMode: "bypassPermissions",
        maxTurns: 50,
        cwd: projectPath,
        timeout: 3_600_000,
        model: resolveModelId(this.config.values.brain.model),
        thinking: { type: "adaptive" },
        effort: "medium",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
        appendSystemPrompt:
          "You are maintaining CLAUDE.md. You CAN edit CLAUDE.md. Do not modify source code.",
      },
    );

    if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    log.info(
      `CLAUDE.md maintenance completed (${Math.round(result.durationMs / 1000)}s, $${result.costUsd.toFixed(4)})`,
    );
  }

  // --- Utility helpers ---

  isSelfProject(): boolean {
    try {
      const pkgPath = join(this.config.projectPath, "package.json");
      if (!existsSync(pkgPath)) return false;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.name === "db-coder";
    } catch {
      return false;
    }
  }

  writeBuildError(error: string): void {
    const dir = join(homedir(), ".db-coder");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "build-error.json"),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          type: "build",
          error,
        },
        null,
        2,
      ),
    );
  }

  acquireLock(): boolean {
    if (existsSync(this.lockFile)) {
      try {
        const pid = parseInt(readFileSync(this.lockFile, "utf-8"), 10);
        if (pid === process.pid) {
          /* same process restart */
        } else {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            /* stale lock */
          }
        }
      } catch {
        /* invalid lock file */
      }
    }
    const lockDir = join(homedir(), ".db-coder");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  releaseLock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* ignore */
    }
  }
}
