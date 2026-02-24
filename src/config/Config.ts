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
  },
  routing: {
    scan: "brain",
    plan: "brain",
    execute_frontend: "claude",
    execute_backend: "codex",
    reflect: "brain",
  },
  budget: { maxPerTask: 20.0, maxPerDay: 300.0, warningThreshold: 0.8 },
  memory: {
    claudeMemUrl: "http://localhost:37777",
    pgConnectionString: "postgresql://db:db@localhost:5432/db_coder",
  },
  git: { branchPrefix: "db-coder/", protectedBranches: ["main", "master"] },
  server: { port: 18800, host: "127.0.0.1" },
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

    this.values = config;
  }
}
