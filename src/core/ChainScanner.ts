import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config/Config.js";
import type { RuntimeAdapter, RunResult } from "../runtime/RuntimeAdapter.js";
import type { TaskStore } from "../memory/TaskStore.js";
import { extractJsonFromText } from "../utils/parse.js";
import { log } from "../utils/logger.js";
import type {
  EntryPoint,
  BoundaryPoint,
  BoundaryFinding,
  TracedChain,
  ChainScanState,
} from "./chain-scanner-types.js";

// ---------------------------------------------------------------------------
// Dependency injection for testing (mirrors countTscErrors pattern)
// ---------------------------------------------------------------------------

interface ChainScannerDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  readdirSync: (
    path: string,
    opts: { withFileTypes: true; recursive?: boolean },
  ) => Dirent[];
}

const defaultDeps: ChainScannerDeps = { existsSync, readFileSync, readdirSync };

let deps: ChainScannerDeps = defaultDeps;

export function setChainScannerDepsForTests(
  overrides?: Partial<ChainScannerDeps>,
): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

// ---------------------------------------------------------------------------
// Deterministic entry-point patterns
// ---------------------------------------------------------------------------

interface PatternDef {
  regex: RegExp;
  kind: EntryPoint["kind"];
  nameExtractor?: (match: RegExpExecArray, file: string) => string;
}

const TS_PATTERNS: PatternDef[] = [
  {
    regex: /route\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*"([^"]+)"/g,
    kind: "http",
    nameExtractor: (m) => `${m[1]} ${m[2]}`,
  },
  {
    regex: /\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  {
    regex: /router\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  {
    regex: /\.command\(\s*["']([^"']+)["']/g,
    kind: "cli",
    nameExtractor: (m) => `command: ${m[1]}`,
  },
  {
    regex: /\.on\(\s*["']([^"']+)["']\s*,/g,
    kind: "event",
    nameExtractor: (m) => `on: ${m[1]}`,
  },
  {
    regex: /setInterval\s*\(/g,
    kind: "timer",
    nameExtractor: (_m, file) => `setInterval in ${file}`,
  },
  {
    regex: /cron\.schedule\s*\(/g,
    kind: "timer",
    nameExtractor: (_m, file) => `cron in ${file}`,
  },
  {
    regex: /export\s+(?:async\s+)?function\s+(\w+)/g,
    kind: "export",
    nameExtractor: (m) => m[1],
  },
];

const PY_PATTERNS: PatternDef[] = [
  {
    regex: /@app\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  {
    regex: /@router\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  {
    regex: /@blueprint\.route\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `route: ${m[1]}`,
  },
  {
    regex: /path\(\s*["']([^"']+)["']/g,
    kind: "http",
    nameExtractor: (m) => `path: ${m[1]}`,
  },
  {
    regex: /@click\.(command|group)/g,
    kind: "cli",
    nameExtractor: (_m, file) => `click command in ${file}`,
  },
  {
    regex: /def\s+main\s*\(/g,
    kind: "cli",
    nameExtractor: (_m, file) => `main() in ${file}`,
  },
  {
    regex: /@(?:app\.task|shared_task|celery_app\.task)/g,
    kind: "event",
    nameExtractor: (_m, file) => `celery task in ${file}`,
  },
  {
    regex: /@receiver\(/g,
    kind: "event",
    nameExtractor: (_m, file) => `signal receiver in ${file}`,
  },
  {
    regex: /@periodic_task/g,
    kind: "timer",
    nameExtractor: (_m, file) => `periodic task in ${file}`,
  },
  {
    regex: /schedule\.every\(/g,
    kind: "timer",
    nameExtractor: (_m, file) => `schedule in ${file}`,
  },
];

// DOM / non-business events to filter out
const IGNORE_EVENTS = new Set([
  "error",
  "close",
  "end",
  "data",
  "drain",
  "finish",
  "readable",
  "exit",
  "SIGINT",
  "SIGTERM",
  "uncaughtException",
  "unhandledRejection",
  "click",
  "change",
  "submit",
  "load",
  "DOMContentLoaded",
  "resize",
  "scroll",
  "keydown",
  "keyup",
  "mousedown",
  "mouseup",
  "mousemove",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function md5Short(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 16);
}

function detectProjectLanguages(projectPath: string): {
  ts: boolean;
  py: boolean;
} {
  const ts =
    deps.existsSync(join(projectPath, "tsconfig.json")) ||
    deps.existsSync(join(projectPath, "package.json"));
  const py =
    deps.existsSync(join(projectPath, "pyproject.toml")) ||
    deps.existsSync(join(projectPath, "setup.py")) ||
    deps.existsSync(join(projectPath, "requirements.txt"));
  return { ts, py };
}

function getLineNumber(content: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "coverage",
  ".next",
  ".nuxt",
]);

function collectSourceFiles(
  projectPath: string,
  extensions: Set<string>,
): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = deps.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (extensions.has(ext)) results.push(fullPath);
      }
    }
  }

  walk(projectPath);
  return results;
}

function scanFileForEntries(
  filePath: string,
  relPath: string,
  patterns: PatternDef[],
): EntryPoint[] {
  let content: string;
  try {
    content = deps.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const entries: EntryPoint[] = [];
  for (const pat of patterns) {
    // Reset regex state
    pat.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pat.regex.exec(content)) !== null) {
      const name = pat.nameExtractor
        ? pat.nameExtractor(match, relPath)
        : match[0];

      // Filter non-business events
      if (pat.kind === "event") {
        const eventName = match[1];
        if (eventName && IGNORE_EVENTS.has(eventName)) continue;
      }

      entries.push({
        name,
        file: relPath,
        line: getLineNumber(content, match.index),
        kind: pat.kind,
      });
    }
  }
  return entries;
}

// Dedup entries by file+line
function deduplicateEntries(entries: EntryPoint[]): EntryPoint[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.file}:${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MAX_FINGERPRINTS = 200;

// ---------------------------------------------------------------------------
// ChainScanner
// ---------------------------------------------------------------------------

export class ChainScanner {
  private readonly brainSession: RuntimeAdapter;

  constructor(
    brainSession: RuntimeAdapter,
    private taskStore: TaskStore,
    private config: Config,
    scanRuntime?: RuntimeAdapter,
  ) {
    // Use dedicated scan runtime if provided; falls back to brain session
    this.brainSession = scanRuntime ?? brainSession;
  }

  // ---- Public API ----

  /**
   * Main trigger: scan the next batch of chains.
   * Called periodically from MainLoop (every N completed tasks).
   */
  async scanNext(projectPath: string): Promise<void> {
    const cfg = this.config.values.brain.chainScan;
    log.info("ChainScanner: starting scanNext");

    // 1. Load or initialize state
    const loaded = await this.taskStore.getChainScanState(projectPath);
    const needsDiscovery =
      !loaded ||
      loaded.entryPoints.length === 0 ||
      loaded.scanCount % cfg.rediscoveryInterval === 0;

    let state: ChainScanState;
    if (!loaded) {
      // First scan ever — discover and create fresh state
      const entryPoints = await this.discoverEntryPoints(projectPath);
      state = {
        projectPath,
        nextIndex: 0,
        entryPoints,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 0,
      };
      log.info(`ChainScanner: discovered ${entryPoints.length} entry points`);
    } else if (needsDiscovery) {
      const entryPoints = await this.discoverEntryPoints(projectPath);
      state = {
        ...loaded,
        entryPoints,
        lastDiscoveryAt: new Date().toISOString(),
      };
      log.info(`ChainScanner: discovered ${entryPoints.length} entry points`);
    } else {
      state = loaded;
    }

    if (state.entryPoints.length === 0) {
      log.warn("ChainScanner: no entry points found, skipping scan");
      await this.taskStore.upsertChainScanState(state);
      return;
    }

    // 2. Select entries by rotation
    const selected = this.selectEntries(state, cfg.chainsPerTrigger);

    // 3. Trace and verify each chain (with budget control)
    let totalCost = 0;
    const allFindings: BoundaryFinding[] = [];

    for (const entry of selected) {
      if (totalCost >= cfg.maxBudget) {
        log.info(
          `ChainScanner: budget exhausted ($${totalCost.toFixed(2)} >= $${cfg.maxBudget}), skipping remaining chains`,
        );
        break;
      }

      try {
        const {
          chain,
          cost: traceCost,
          sessionId,
        } = await this.traceChain(entry, projectPath);
        totalCost += traceCost;

        if (chain.boundaries.length > 0 && totalCost < cfg.maxBudget) {
          const { findings, cost: verifyCost } = await this.verifyBoundaries(
            chain,
            projectPath,
            sessionId,
          );
          totalCost += verifyCost;
          allFindings.push(...findings);
        }
      } catch (err) {
        log.warn(`ChainScanner: failed to scan chain "${entry.name}"`, err);
      }
    }

    // 4. Create tasks from new findings (dedup by fingerprint)
    let tasksCreated = 0;
    const fingerprintSet = new Set(state.knownFingerprints);

    for (const finding of allFindings) {
      if (fingerprintSet.has(finding.fingerprint)) continue;

      const desc = `[chain-scan] ${finding.mismatch} (${finding.boundary.crossing})`;
      const priority =
        finding.severity === "critical"
          ? 0
          : finding.severity === "high"
            ? 1
            : 2;

      // Check for similar existing tasks
      const similar = await this.taskStore.findSimilarTask(projectPath, desc);
      if (similar) continue;

      const recentlyFailed = await this.taskStore.hasRecentlyFailedSimilar(
        projectPath,
        desc,
      );
      if (recentlyFailed) continue;

      await this.taskStore.createTask(projectPath, desc, priority, [], {
        spawnReason: "chain-scan",
      });
      fingerprintSet.add(finding.fingerprint);
      tasksCreated++;
    }

    // 5. Update state
    const updatedFingerprints = [...fingerprintSet];
    // FIFO trim to MAX_FINGERPRINTS
    if (updatedFingerprints.length > MAX_FINGERPRINTS) {
      updatedFingerprints.splice(
        0,
        updatedFingerprints.length - MAX_FINGERPRINTS,
      );
    }

    const updatedState: ChainScanState = {
      ...state,
      nextIndex:
        (state.nextIndex + cfg.chainsPerTrigger) % state.entryPoints.length,
      knownFingerprints: updatedFingerprints,
      lastScanAt: new Date().toISOString(),
      scanCount: state.scanCount + 1,
    };
    await this.taskStore.upsertChainScanState(updatedState);

    // 6. Track cost
    if (totalCost > 0) {
      await this.taskStore.addDailyCost(totalCost);
    }

    log.info(
      `ChainScanner: completed (${selected.length} chains, ${allFindings.length} findings, ${tasksCreated} tasks created, $${totalCost.toFixed(2)})`,
    );
  }

  /**
   * Full scan: re-discover + scan all chains (for manual triggers).
   */
  async fullScan(projectPath: string): Promise<void> {
    const entryPoints = await this.discoverEntryPoints(projectPath);
    const existing = await this.taskStore.getChainScanState(projectPath);
    const freshState: ChainScanState = existing
      ? {
          ...existing,
          entryPoints,
          nextIndex: 0,
          lastDiscoveryAt: new Date().toISOString(),
        }
      : {
          projectPath,
          nextIndex: 0,
          entryPoints,
          knownFingerprints: [],
          lastDiscoveryAt: new Date().toISOString(),
          lastScanAt: "",
          scanCount: 0,
        };
    await this.taskStore.upsertChainScanState(freshState);

    // Scan all entry points in sequence
    for (let i = 0; i < entryPoints.length; i += 2) {
      const current = await this.taskStore.getChainScanState(projectPath);
      if (current) {
        await this.taskStore.upsertChainScanState({
          ...current,
          nextIndex: i,
        });
      }
      await this.scanNext(projectPath);
    }
  }

  // ---- Phase 1: Entry Discovery ----

  /**
   * Discover entry points: deterministic regex scan + optional AI refinement.
   */
  async discoverEntryPoints(projectPath: string): Promise<EntryPoint[]> {
    // Phase A: deterministic scan
    const rawEntries = this.deterministicScan(projectPath);

    if (rawEntries.length === 0) {
      log.info("ChainScanner: no entry points found by deterministic scan");
      return [];
    }

    // Phase B: AI refinement (sort, filter, supplement)
    try {
      const refined = await this.aiRefineEntryPoints(rawEntries, projectPath);
      return refined;
    } catch (err) {
      log.warn("ChainScanner: AI refinement failed, using raw entries", err);
      return rawEntries;
    }
  }

  /**
   * Deterministic entry-point scan (zero AI cost).
   * Exported for direct testing.
   */
  deterministicScan(projectPath: string): EntryPoint[] {
    const langs = detectProjectLanguages(projectPath);
    const allEntries: EntryPoint[] = [];

    if (langs.ts) {
      const tsExtensions = new Set([".ts", ".js", ".tsx", ".jsx"]);
      const files = collectSourceFiles(projectPath, tsExtensions);
      for (const file of files) {
        const relPath = relative(projectPath, file);
        // Skip test files for entry discovery
        if (
          relPath.includes(".test.") ||
          relPath.includes(".spec.") ||
          relPath.includes("__tests__")
        )
          continue;
        allEntries.push(...scanFileForEntries(file, relPath, TS_PATTERNS));
      }
    }

    if (langs.py) {
      const pyExtensions = new Set([".py"]);
      const files = collectSourceFiles(projectPath, pyExtensions);
      for (const file of files) {
        const relPath = relative(projectPath, file);
        if (
          relPath.includes("test_") ||
          relPath.includes("_test.") ||
          relPath.includes("tests/")
        )
          continue;
        allEntries.push(...scanFileForEntries(file, relPath, PY_PATTERNS));
      }
    }

    return deduplicateEntries(allEntries);
  }

  // ---- Phase 2: Chain Tracing ----

  private async traceChain(
    entry: EntryPoint,
    projectPath: string,
  ): Promise<{ chain: TracedChain; cost: number; sessionId?: string }> {
    const prompt = `Given this entry point: "${entry.name}" in ${entry.file}:${entry.line} (kind: ${entry.kind})

Task: Trace the execution chain from this entry point.

1. Read the entry function's code
2. For each function call:
   a. If the call crosses a file/module boundary → record as a boundary
   b. Read the called function, continue depth-first tracing
   c. Max depth: 5 levels, max function calls: 15
3. For each boundary, record:
   - crossing: "A.method → B.method"
   - producerFile / consumerFile (relative paths)
   - dataFlowing: what data is passed

Output ONLY a JSON object with this structure:
{
  "callPath": ["Module.method1", "Module.method2", ...],
  "boundaries": [
    {
      "crossing": "A.method → B.method",
      "producerFile": "src/a.ts",
      "consumerFile": "src/b.ts",
      "dataFlowing": "SessionResult with costUsd, isError, sessionId fields",
      "producerContract": "returns SessionResult, sessionId is non-empty on success",
      "consumerAssumption": "sessionId is truthy when session ran"
    }
  ]
}`;

    const result = await this.brainSession.run(prompt, {
      cwd: projectPath,
      maxTurns: 25,
      timeout: 300_000,
      model:
        this.config.values.routing.scan.model || this.config.values.brain.model,
      readOnly: true,
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      systemPrompt:
        "You are tracing an execution chain. Read code files to follow the call graph. Output ONLY valid JSON.",
    });

    const parsed = extractJsonFromText(result.text, (v) => {
      if (typeof v !== "object" || v === null) return false;
      const obj = v as Record<string, unknown>;
      return Array.isArray(obj.callPath) && Array.isArray(obj.boundaries);
    }) as { callPath: string[]; boundaries: BoundaryPoint[] } | null;

    if (!parsed) {
      log.warn(
        `ChainScanner: failed to parse traceChain result for "${entry.name}"`,
      );
      return {
        chain: { entryPoint: entry, callPath: [], boundaries: [] },
        cost: result.costUsd,
      };
    }

    return {
      chain: {
        entryPoint: entry,
        callPath: parsed.callPath,
        boundaries: parsed.boundaries,
      },
      cost: result.costUsd,
      sessionId: !result.isError ? result.sessionId : undefined,
    };
  }

  // ---- Phase 3: Boundary Verification ----

  private async verifyBoundaries(
    chain: TracedChain,
    projectPath: string,
    resumeSessionId?: string,
  ): Promise<{ findings: BoundaryFinding[]; cost: number }> {
    const boundariesJson = JSON.stringify(chain.boundaries, null, 2);

    // Only use resume if the runtime unconditionally supports it;
    // otherwise the abbreviated prompt would lose the chain context.
    const canResume =
      this.brainSession.capabilities.sessionPersistence === true;
    const effectiveResumeId =
      canResume && resumeSessionId ? resumeSessionId : undefined;

    const prompt = effectiveResumeId
      ? `--- BOUNDARY VERIFICATION ---
Now verify the boundaries you found in the chain above.

For each boundary:
1. Read the PRODUCER code — what does it actually return in ALL paths (normal, error, timeout)?
2. Read the CONSUMER code — what does it assume about the input? How does it handle null, "", 0, -1?
3. Compare contracts:
   - null vs "" vs undefined (these behave differently with ||, ??, &&)
   - -1 vs 0 (error sentinel vs valid value)
   - || vs ?? (|| treats "" and 0 as falsy; ?? only treats null/undefined)
   - .catch(()=>{}) silently swallowing vs propagating errors
   - Promise<T> where T might be undefined but consumer doesn't check
4. ONLY report REAL mismatches where data can actually flow incorrectly.

Output ONLY a JSON object:
{
  "findings": [
    {
      "boundary": { "crossing": "A → B", "producerFile": "...", "consumerFile": "...", "dataFlowing": "...", "producerContract": "...", "consumerAssumption": "..." },
      "mismatch": "specific description of what's wrong",
      "severity": "critical|high|medium",
      "failureScenario": "what concrete problem this causes"
    }
  ]
}

If all boundaries are clean, return: { "findings": [] }`
      : `You are a boundary contract auditor. Verify the following cross-module boundaries.

## Chain: ${chain.entryPoint.name} (${chain.entryPoint.file})
## Call path: ${chain.callPath.join(" → ")}

## Boundaries to verify:
${boundariesJson}

For each boundary:
1. Read the PRODUCER code — what does it actually return in ALL paths (normal, error, timeout)?
2. Read the CONSUMER code — what does it assume about the input? How does it handle null, "", 0, -1?
3. Compare contracts:
   - null vs "" vs undefined (these behave differently with ||, ??, &&)
   - -1 vs 0 (error sentinel vs valid value)
   - || vs ?? (|| treats "" and 0 as falsy; ?? only treats null/undefined)
   - .catch(()=>{}) silently swallowing vs propagating errors
   - Promise<T> where T might be undefined but consumer doesn't check
4. ONLY report REAL mismatches where data can actually flow incorrectly.
   Do NOT report theoretical issues that can't happen in practice.

Output ONLY a JSON object:
{
  "findings": [
    {
      "boundary": { "crossing": "A → B", "producerFile": "...", "consumerFile": "...", "dataFlowing": "...", "producerContract": "...", "consumerAssumption": "..." },
      "mismatch": "specific description of what's wrong",
      "severity": "critical|high|medium",
      "failureScenario": "what concrete problem this causes"
    }
  ]
}

If all boundaries are clean, return: { "findings": [] }`;

    const result = await this.brainSession.run(prompt, {
      cwd: projectPath,
      maxTurns: 35,
      timeout: 600_000,
      model:
        this.config.values.routing.scan.model || this.config.values.brain.model,
      readOnly: true,
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      systemPrompt: effectiveResumeId
        ? undefined
        : "You are auditing boundary contracts. Read both producer and consumer code. Only report verified mismatches. Output ONLY valid JSON.",
      resumeSessionId: effectiveResumeId,
    });

    const parsed = extractJsonFromText(result.text, (v) => {
      if (typeof v !== "object" || v === null) return false;
      const obj = v as Record<string, unknown>;
      return Array.isArray(obj.findings);
    }) as { findings: Array<Omit<BoundaryFinding, "fingerprint">> } | null;

    if (!parsed) {
      log.warn(
        `ChainScanner: failed to parse verifyBoundaries result for "${chain.entryPoint.name}"`,
      );
      return { findings: [], cost: result.costUsd };
    }

    // Compute fingerprints
    const findings: BoundaryFinding[] = parsed.findings.map((f) => ({
      ...f,
      fingerprint: md5Short((f.boundary?.crossing ?? "") + (f.mismatch ?? "")),
    }));

    return { findings, cost: result.costUsd };
  }

  // ---- Private helpers ----

  private async aiRefineEntryPoints(
    rawEntries: EntryPoint[],
    projectPath: string,
  ): Promise<EntryPoint[]> {
    // Cap the list sent to AI to avoid huge prompts
    const capped = rawEntries.slice(0, 100);
    const entriesJson = JSON.stringify(capped, null, 2);

    const prompt = `Here are ${capped.length} entry points discovered by static regex scanning in this project.

${entriesJson}

Please:
1. Sort by importance (user-visible endpoints > internal exports)
2. Remove false positives (e.g., utility exports that aren't real entry points)
3. Add up to 5 entry points you notice are missing from important non-standard patterns
4. Keep only the top 30 most important entries

Output ONLY a JSON array of EntryPoint objects:
[{ "name": "...", "file": "...", "line": <number>, "kind": "http|cli|event|timer|export|other" }]`;

    const result = await this.brainSession.run(prompt, {
      cwd: projectPath,
      maxTurns: 5,
      timeout: 120_000,
      model:
        this.config.values.routing.scan.model || this.config.values.brain.model,
      readOnly: true,
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      systemPrompt:
        "You are filtering and sorting entry points. Output ONLY a JSON array.",
    });

    const parsed = extractJsonFromText(result.text, (v) => Array.isArray(v)) as
      | EntryPoint[]
      | null;

    if (!parsed || parsed.length === 0) {
      log.warn("ChainScanner: AI refinement returned no results, using raw");
      return rawEntries;
    }

    return parsed;
  }

  /**
   * Select the next batch of entry points by rotation index.
   */
  private selectEntries(state: ChainScanState, count: number): EntryPoint[] {
    const entries = state.entryPoints;
    if (entries.length === 0) return [];

    const selected: EntryPoint[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (state.nextIndex + i) % entries.length;
      selected.push(entries[idx]);
    }
    return selected;
  }
}
