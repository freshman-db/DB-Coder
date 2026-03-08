import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { DbCoderConfig, DeepPartial } from "./types.js";

const DEFAULTS: DbCoderConfig = {
  apiToken: "",
  brain: {
    model: "opus",
    scanInterval: 300,
    maxScanBudget: 1.0,
    claudeMdMaintenanceInterval: 15,
    claudeMdMaintenanceEnabled: true,
    chainScan: {
      enabled: true,
      interval: 5,
      maxBudget: 3.0,
      chainsPerTrigger: 2,
      rediscoveryInterval: 10,
    },
    language: "简体中文",
  },
  claude: { model: "opus", maxTaskBudget: 10.0, maxTurns: 200 },
  codex: {
    model: "gpt-5.3-codex",
    sandbox: "workspace-write",
    tokenPricing: {
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14,
    },
  },
  autonomy: {
    level: "full",
    maxRetries: 3,
    retryBaseDelayMs: 1000,
    subtaskTimeout: 600,
    worker: "claude", // deprecated: use routing.execute/review instead
    maxReviewFixes: 1,
  },
  routing: {
    brain: { runtime: "claude-sdk", model: "claude-opus-4-6" },
    plan: { runtime: "claude-sdk", model: "claude-opus-4-6" },
    execute: { runtime: "claude-sdk", model: "claude-opus-4-6" },
    review: { runtime: "codex-cli", model: "gpt-5.3-codex" },
    reflect: { runtime: "claude-sdk", model: "claude-opus-4-6" },
    scan: { runtime: "claude-sdk", model: "claude-opus-4-6" },
  },
  budget: { maxPerTask: 20.0, maxPerDay: 300.0, warningThreshold: 0.8 },
  memory: {
    claudeMemUrl: "http://localhost:37777",
    pgConnectionString: "postgresql://db:db@localhost:5432/db_coder",
  },
  git: {
    branchPrefix: "db-coder/",
    protectedBranches: ["main", "master"],
    branchRetentionDays: 7,
  },
  server: { port: 18801, host: "127.0.0.1" },
  mcp: { enabled: true },
  plugins: {},
  evolution: {
    goals: [
      {
        description: "提升代码质量：修复类型错误，统一编码规范",
        priority: 1,
        status: "active",
      },
      {
        description: "减少代码重复：识别和整合重复模式",
        priority: 2,
        status: "active",
      },
      {
        description: "简化复杂代码：缩短函数长度，降低嵌套深度",
        priority: 2,
        status: "active",
      },
      {
        description: "提高测试覆盖：为关键路径添加测试",
        priority: 2,
        status: "active",
      },
      {
        description: "主动开发功能：识别架构的自然延伸并实现",
        priority: 3,
        status: "active",
      },
    ],
  },
  experimental: {
    brainDriven: false,
    strictModelRouting: false,
  },
};

function deepMerge(
  target: DbCoderConfig,
  source: DeepPartial<DbCoderConfig>,
): DbCoderConfig {
  return mergeObjects(
    target as unknown as Record<string, unknown>,
    source as unknown as Record<string, unknown>,
    0,
  ) as unknown as DbCoderConfig;
}

const MAX_MERGE_DEPTH = 3;

function mergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sv] of Object.entries(source)) {
    if (
      sv !== undefined &&
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv)
    ) {
      const tv = result[key];
      if (
        depth < MAX_MERGE_DEPTH &&
        tv !== undefined &&
        tv !== null &&
        typeof tv === "object" &&
        !Array.isArray(tv)
      ) {
        result[key] = mergeObjects(
          tv as Record<string, unknown>,
          sv as Record<string, unknown>,
          depth + 1,
        );
      } else {
        result[key] = { ...sv };
      }
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

function loadJsonFile(path: string): DeepPartial<DbCoderConfig> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeApiToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

function generateApiToken(): string {
  return randomBytes(32).toString("hex");
}

function persistApiToken(
  path: string,
  config: DeepPartial<DbCoderConfig>,
  apiToken: string,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(path, `${JSON.stringify({ ...config, apiToken }, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  // Tighten permissions on pre-existing files that may have been created with a
  // permissive umask (writeFileSync mode only applies when creating a new file).
  chmodSync(path, 0o600);
}

/** Model alias map — only used during Config construction for normalization. */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
};

/** Resolve a model alias to its canonical ID. Internal to Config normalization. */
function resolveModelAlias(alias: string): string {
  return MODEL_ALIASES[alias] ?? alias;
}

export class Config {
  readonly values: DbCoderConfig;
  readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;

    const globalPath = join(homedir(), ".db-coder", "config.json");
    const projectConfigPath = join(projectPath, ".db-coder.json");

    let config = { ...DEFAULTS };
    const globalOverrides = loadJsonFile(globalPath);
    if (globalOverrides) config = deepMerge(config, globalOverrides);
    const projectOverrides = loadJsonFile(projectConfigPath);
    if (projectOverrides) config = deepMerge(config, projectOverrides);

    const apiToken = normalizeApiToken(config.apiToken);
    if (apiToken) {
      config.apiToken = apiToken;
    } else {
      const generatedToken = generateApiToken();
      config.apiToken = generatedToken;
      persistApiToken(globalPath, globalOverrides ?? {}, generatedToken);
    }

    // Normalize routing config: both model aliases and runtime aliases.
    // After this block, downstream code sees only canonical values.
    if (config.routing) {
      const phases = [
        "brain",
        "plan",
        "execute",
        "review",
        "reflect",
        "scan",
      ] as const;
      // Runtime alias map (must stay in sync with runtimeFactory.ts)
      const RUNTIME_ALIASES: Record<string, string> = {
        claude: "claude-sdk",
        codex: "codex-sdk",
      };
      const normalized = { ...config.routing };
      for (const phase of phases) {
        const pr = normalized[phase];
        if (!pr) continue;
        let changed = false;
        let newPr = pr;
        // Normalize runtime alias (e.g. "codex" → "codex-sdk")
        if (pr.runtime && RUNTIME_ALIASES[pr.runtime]) {
          newPr = { ...newPr, runtime: RUNTIME_ALIASES[pr.runtime] };
          changed = true;
        }
        // Normalize model alias (e.g. "opus" → "claude-opus-4-6")
        if (pr.model) {
          const resolved = resolveModelAlias(pr.model);
          if (resolved !== pr.model) {
            newPr = { ...newPr, model: resolved };
            changed = true;
          }
        }
        if (changed) {
          normalized[phase] = newPr;
        }
      }
      config = { ...config, routing: normalized };
    }

    // Normalize model aliases in brain.model and claude.model
    if (config.brain?.model) {
      const resolved = resolveModelAlias(config.brain.model);
      if (resolved !== config.brain.model) {
        config = { ...config, brain: { ...config.brain, model: resolved } };
      }
    }
    if (config.claude?.model) {
      const resolved = resolveModelAlias(config.claude.model);
      if (resolved !== config.claude.model) {
        config = { ...config, claude: { ...config.claude, model: resolved } };
      }
    }

    this.values = config;
  }
}
