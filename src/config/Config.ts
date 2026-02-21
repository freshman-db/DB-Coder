import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { DbCoderConfig, DeepPartial } from './types.js';

const DEFAULTS: DbCoderConfig = {
  apiToken: '',
  brain: { model: 'opus', scanInterval: 3600, maxScanBudget: 1.0 },
  claude: { model: 'opus', maxTaskBudget: 2.0, maxTurns: 30 },
  codex: {
    model: 'gpt-5.3-codex',
    sandbox: 'workspace-write',
    tokenPricing: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
  },
  autonomy: { level: 'full', maxRetries: 3, subtaskTimeout: 600 },
  routing: {
    scan: 'brain', plan: 'brain',
    execute_frontend: 'claude', execute_backend: 'codex',
    review: ['claude', 'codex'], reflect: 'brain',
  },
  budget: { maxPerTask: 5.0, maxPerDay: 200.0, warningThreshold: 0.8 },
  memory: {
    claudeMemUrl: 'http://localhost:37777',
    pgConnectionString: 'postgresql://db:db@localhost:5432/db_coder',
  },
  git: { branchPrefix: 'db-coder/', protectedBranches: ['main', 'master'] },
  server: { port: 18800, host: '127.0.0.1' },
  mcp: { enabled: true },
  plugins: {},
  evolution: {
    goals: [
      { description: '提升代码质量：修复类型错误，统一编码规范', priority: 1, status: 'active' },
      { description: '减少代码重复：识别和整合重复模式', priority: 2, status: 'active' },
      { description: '简化复杂代码：缩短函数长度，降低嵌套深度', priority: 2, status: 'active' },
      { description: '提高测试覆盖：为关键路径添加测试', priority: 2, status: 'active' },
      { description: '主动开发功能：识别架构的自然延伸并实现', priority: 3, status: 'active' },
    ],
  },
};

function deepMerge(target: DbCoderConfig, source: DeepPartial<DbCoderConfig>): DbCoderConfig {
  const result = { ...target } as Record<string, unknown>;
  for (const [key, sv] of Object.entries(source)) {
    if (sv !== undefined && sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
      result[key] = { ...(result[key] as Record<string, unknown>), ...sv };
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as unknown as DbCoderConfig;
}

function loadJsonFile(path: string): DeepPartial<DbCoderConfig> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeApiToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

function generateApiToken(): string {
  return randomBytes(32).toString('hex');
}

function persistApiToken(path: string, config: DeepPartial<DbCoderConfig>, apiToken: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, `${JSON.stringify({ ...config, apiToken }, null, 2)}\n`, 'utf-8');
}

export class Config {
  readonly values: DbCoderConfig;
  readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;

    const globalPath = join(homedir(), '.db-coder', 'config.json');
    const projectConfigPath = join(projectPath, '.db-coder.json');

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
