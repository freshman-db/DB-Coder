#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { Config } from "./config/Config.js";
import { Client } from "./client/Client.js";
import { GlobalMemory } from "./memory/GlobalMemory.js";
import { TaskStore } from "./memory/TaskStore.js";
import { TaskQueue } from "./core/TaskQueue.js";
import { MainLoop } from "./core/MainLoop.js";
import { CycleEventBus } from "./core/CycleEventBus.js";
import { registerGuards } from "./core/guards/index.js";
import { registerObservers } from "./core/observers/index.js";
import { registerStrategies } from "./core/strategies/index.js";
import { CostTracker } from "./utils/cost.js";
import { Server } from "./server/Server.js";
import { emitSseEvent } from "./server/routes.js";
import { PatrolManager } from "./core/ModeManager.js";
import { PlanChatManager } from "./core/PlanChatManager.js";
import { log, type LogEntry } from "./utils/logger.js";
import { truncate } from "./utils/parse.js";
import {
  validateConfigForStartup,
  validateRuntimeAvailability,
} from "./startup/configValidation.js";
import { wireGracefulShutdown } from "./startup/gracefulShutdown.js";
import { checkAndRecoverErrors } from "./startup/errorRecovery.js";
import { TASK_DESC_MAX_LENGTH } from "./types/constants.js";
import { discoverPlugins } from "./bridges/pluginDiscovery.js";
import { buildHooks } from "./bridges/hooks.js";
import type { SdkExtras } from "./bridges/buildSdkOptions.js";

const program = new Command()
  .name("db-coder")
  .description("Autonomous AI coding agent")
  .version("0.1.0");

// --- serve ---
program
  .command("serve")
  .description("Start the db-coder service")
  .option("-p, --project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    log.info(`Starting db-coder for project: ${projectPath}`);

    const config = new Config(projectPath);
    if (!validateConfigForStartup(config.values, config.projectPath)) {
      process.exitCode = 1;
      return;
    }

    // Verify configured runtimes are actually installed/reachable
    const runtimeIssues = await validateRuntimeAvailability(
      config.values.routing,
    );
    if (runtimeIssues.length > 0) {
      for (const issue of runtimeIssues) log.error(`Runtime check: ${issue}`);
      process.exitCode = 1;
      return;
    }

    const { memory, budget } = config.values;

    // Initialize components
    const globalMemory = new GlobalMemory(memory.pgConnectionString);
    const taskStore = new TaskStore(memory.pgConnectionString);

    await globalMemory.init();
    await taskStore.init();

    // Check for error files from previous failed builds
    const recoveredErrors = await checkAndRecoverErrors(taskStore, projectPath);
    if (recoveredErrors > 0) {
      log.warn(
        `Created ${recoveredErrors} P0 recovery task(s) from previous errors`,
      );
    }
    const taskQueue = new TaskQueue(taskStore);
    const costTracker = new CostTracker(taskStore, budget);

    const eventBus = new CycleEventBus();

    registerGuards(eventBus, {
      getDiffStats: async (startCommit: string) => {
        const { getDiffStats } = await import("./utils/git.js");
        const stats = await getDiffStats(startCommit, "HEAD", projectPath);
        return {
          filesChanged: stats.files_changed,
          insertions: stats.insertions,
          deletions: stats.deletions,
        };
      },
      getBudgetInfo: async () => {
        const dailyCost = await taskStore.getDailyCost();
        return {
          remainingUsd:
            config.values.budget.maxPerDay - dailyCost.total_cost_usd,
          avgTaskCostUsd: 2,
        };
      },
      lockFile: `${process.env.HOME}/.db-coder/patrol.lock`,
    });

    const observers = registerObservers(eventBus, {
      sseBroadcast: emitSseEvent,
    });

    const strategies = registerStrategies(eventBus, {
      getProjectHealth: async () => {
        const metrics = await taskStore.getOperationalMetrics(projectPath);
        return {
          tscErrors: 0, // TODO: wire actual tsc error count
          recentSuccessRate: metrics.taskPassRate,
          blockedTaskCount: metrics.tasksByStatus["blocked"] ?? 0,
        };
      },
    });

    // Discover plugins and build hooks for SDK sessions
    const plugins = discoverPlugins();
    const hooks = buildHooks({
      onToolResult: (name, _input, _response) => {
        log.debug(`Tool used: ${name}`);
      },
    });
    const sdkExtras: SdkExtras = {
      plugins,
      hooks,
    };

    const mainLoop = new MainLoop(
      config,
      taskQueue,
      taskStore,
      costTracker,
      eventBus,
      sdkExtras,
      undefined, // workerAdapter
      undefined, // reviewAdapter
      strategies,
      buildCliCmd(),
    );
    const patrolManager = new PatrolManager(mainLoop, taskStore, projectPath);
    // Plan chat uses the plan phase runtime resolved by MainLoop (with SDK→CLI fallback).
    const planChat = new PlanChatManager(
      taskStore,
      config,
      mainLoop.planRuntime,
    );
    const restored = await planChat.restoreSessions();
    if (restored > 0) log.info(`Restored ${restored} active chat session(s)`);

    const server = new Server(
      config,
      mainLoop,
      taskStore,
      globalMemory,
      costTracker,
      observers,
      patrolManager,
      planChat,
    );

    // Global error handlers
    process.on("unhandledRejection", (err) => {
      log.error("Unhandled rejection", err);
    });
    process.on("uncaughtException", (err) => {
      log.error("Uncaught exception", err);
    });

    wireGracefulShutdown({
      mainLoop,
      server,
      taskStore,
      globalMemory,
    });

    // Register restart handler for self-build scenarios
    const RESTART_EXIT_CODE = 75;
    mainLoop.onRestart(() => {
      log.info(`Self-build restart: exiting with code ${RESTART_EXIT_CODE}`);
      server.stop().catch(() => {});
      globalMemory.close().catch(() => {});
      taskStore.close().catch(() => {});
      process.exit(RESTART_EXIT_CODE);
    });

    await server.start();

    // Resume patrol if it was active before shutdown/restart
    try {
      if (await patrolManager.shouldResumePatrol()) {
        log.info("Resuming patrol from previous session");
        await patrolManager.startPatrol();
      } else {
        log.info("db-coder ready. Awaiting mode selection via Web UI or API.");
      }
    } catch (err) {
      log.warn(`Failed to resume patrol: ${err}`);
      log.info("db-coder ready. Awaiting mode selection via Web UI or API.");
    }
  });

// --- Client commands ---
function getClient(): Client {
  const { port, host, apiToken } = Config.loadClientConfig();
  return new Client(port, host, apiToken || undefined);
}

/** Run a client action with unified connection error handling. */
async function withClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  try {
    await fn(getClient());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
      console.error("Service not running. Start with: db-coder serve");
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Compute absolute CLI invocation command, safe for use in shell prompts. */
function buildCliCmd(): string {
  const entry = process.argv[1];
  if (!entry) {
    log.warn(
      "process.argv[1] is undefined; cliCmd will use process.execPath only",
    );
    return shellEscape(process.execPath);
  }
  return `${shellEscape(process.execPath)} ${shellEscape(resolve(entry))}`;
}

function isLogEntry(entry: unknown): entry is LogEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const c = entry as {
    timestamp?: unknown;
    level?: unknown;
    message?: unknown;
  };
  return (
    typeof c.timestamp === "string" &&
    (c.level === "debug" ||
      c.level === "info" ||
      c.level === "warn" ||
      c.level === "error") &&
    typeof c.message === "string"
  );
}

program
  .command("status")
  .description("Show service status")
  .action(() =>
    withClient(async (client) => {
      const status = await client.status();
      console.log(JSON.stringify(status, null, 2));
    }),
  );

program
  .command("add <description>")
  .description("Add a task")
  .option("-p, --priority <n>", "Priority (0=urgent, 3=optional)", "2")
  .option("--json", "Output as JSON")
  .action((description, opts) =>
    withClient(async (client) => {
      const task = await client.addTask(description, parseInt(opts.priority));
      if (opts.json) {
        console.log(JSON.stringify(task));
      } else {
        console.log("Task added:", JSON.stringify(task, null, 2));
      }
    }),
  );

program
  .command("queue")
  .description("Show task queue")
  .option(
    "--status <status>",
    "Filter by status (queued, active, done, failed, blocked, skipped, pending_review)",
  )
  .option("--json", "Output as JSON")
  .action((opts) =>
    withClient(async (client) => {
      const { tasks } = await client.listTasks(opts.status);
      if (opts.json) {
        console.log(JSON.stringify(tasks));
        return;
      }
      if (tasks.length === 0) {
        console.log("No tasks.");
        return;
      }
      for (const t of tasks) {
        const statusIcon: string =
          {
            queued: "⏳",
            active: "🔄",
            done: "✅",
            failed: "❌",
            blocked: "🚫",
            skipped: "⏭️",
            pending_review: "👀",
          }[t.status] ?? "?";
        console.log(
          `${statusIcon} [P${t.priority}] ${truncate(t.task_description, TASK_DESC_MAX_LENGTH)}  (${t.id.slice(0, 8)})`,
        );
      }
    }),
  );

program
  .command("logs")
  .description("Show real-time logs")
  .option("-f, --follow", "Follow log stream")
  .action((opts) =>
    withClient(async (client) => {
      if (opts.follow) {
        console.log("Following logs (Ctrl+C to stop)...");
        await client.followLogs((entry) => {
          if (!isLogEntry(entry)) return;
          const { timestamp, level, message } = entry;
          console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
        });
      } else {
        const status = await client.status();
        console.log(JSON.stringify(status, null, 2));
      }
    }),
  );

program
  .command("pause")
  .description("Pause the main loop")
  .action(() =>
    withClient(async (client) => {
      await client.pause();
      console.log("Paused.");
    }),
  );

program
  .command("resume")
  .description("Resume the main loop")
  .action(() =>
    withClient(async (client) => {
      await client.resume();
      console.log("Resumed.");
    }),
  );

program
  .command("scan")
  .description("Trigger a project scan")
  .option("--deep", "Deep scan")
  .action((opts) =>
    withClient(async (client) => {
      const depth = opts.deep ? "deep" : "normal";
      await client.triggerScan(depth);
      console.log(`Scan triggered (${depth}).`);
    }),
  );

program
  .command("cost")
  .description("Show cost details")
  .action(() =>
    withClient(async (client) => {
      const cost = await client.getCost();
      console.log(JSON.stringify(cost, null, 2));
    }),
  );

program
  .command("blocked")
  .description("Show blocked tasks")
  .option("--json", "Output as JSON")
  .action((opts) =>
    withClient(async (client) => {
      const { tasks } = await client.listTasks("blocked");
      if (opts.json) {
        console.log(JSON.stringify(tasks));
        return;
      }
      if (tasks.length === 0) {
        console.log("No blocked tasks.");
        return;
      }
      for (const t of tasks) {
        console.log(
          `🚫 [P${t.priority}] ${truncate(t.task_description, TASK_DESC_MAX_LENGTH)}  (${t.id.slice(0, 8)})`,
        );
      }
    }),
  );

program
  .command("blocked-summary")
  .description("Show blocked task summary with failure patterns")
  .option("--window <hours>", "Lookback window in hours", "48")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const raw: string = opts.window;
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      console.error("Error: --window must be a positive integer.");
      process.exitCode = 1;
      return;
    }
    return withClient(async (client) => {
      const summary = await client.getBlockedSummary(Number(raw));
      if (opts.json) {
        console.log(JSON.stringify(summary));
      } else {
        console.log(`Blocked tasks: ${summary.blockedCount}`);
        if (summary.recentFailures.length > 0) {
          console.log("Recent failures:");
          for (const f of summary.recentFailures) {
            console.log(`  - ${JSON.stringify(f)}`);
          }
        }
      }
    });
  });

program
  .command("task <id>")
  .description("Show task details")
  .option("--json", "Output as JSON")
  .action((id, opts) =>
    withClient(async (client) => {
      const task = await client.getTask(id);
      if (opts.json) {
        console.log(JSON.stringify(task));
      } else {
        console.log(JSON.stringify(task, null, 2));
      }
    }),
  );

program
  .command("task-logs <id>")
  .description("Show task execution logs")
  .option("--json", "Output as JSON")
  .action((id, opts) =>
    withClient(async (client) => {
      const logs = await client.getTaskLogs(id);
      if (opts.json) {
        console.log(JSON.stringify(logs));
      } else {
        if (logs.length === 0) {
          console.log("No logs.");
          return;
        }
        for (const l of logs) {
          const ts =
            l.created_at instanceof Date
              ? l.created_at.toISOString()
              : String(l.created_at);
          console.log(
            `[${ts}] ${l.phase}: ${truncate(String(l.output_summary ?? ""), 200)}`,
          );
        }
      }
    }),
  );

program
  .command("metrics")
  .description("Show operational metrics")
  .option("--json", "Output as JSON")
  .action((opts) =>
    withClient(async (client) => {
      const m = await client.metrics();
      if (opts.json) {
        console.log(JSON.stringify(m));
      } else {
        console.log(JSON.stringify(m, null, 2));
      }
    }),
  );

program
  .command("requeue <ids...>")
  .description("Requeue blocked/failed tasks")
  .option("--json", "Output as JSON")
  .action((ids, opts) =>
    withClient(async (client) => {
      const result = await client.requeueTasks(ids);
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(
          `Requeued ${result.requeued} of ${result.requested} task(s).`,
        );
      }
    }),
  );

program.parse();
