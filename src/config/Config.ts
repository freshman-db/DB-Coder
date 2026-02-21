import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DbCoderConfig, DeepPartial } from './types.js';

const DEFAULTS: DbCoderConfig = {
  brain: { model: 'opus', scanInterval: 3600, maxScanBudget: 1.0 },
  claude: { model: 'opus', maxTaskBudget: 2.0, maxTurns: 30 },
  codex: { model: 'o3', sandbox: 'workspace-write' },
  autonomy: { level: 'full', maxRetries: 3, subtaskTimeout: 600 },
  routing: {
    scan: 'brain', plan: 'brain',
    execute_frontend: 'claude', execute_backend: 'codex',
    review: ['claude', 'codex'], reflect: 'brain',
  },
  budget: { maxPerTask: 5.0, maxPerDay: 20.0, warningThreshold: 0.8 },
  memory: {
    claudeMemUrl: 'http://localhost:37777',
    pgConnectionString: 'postgresql://db:db@localhost:5432/db_coder',
  },
  git: { branchPrefix: 'db-coder/', protectedBranches: ['main', 'master'] },
  server: { port: 18800, host: '127.0.0.1' },
  evolution: { goals: [] },
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

    this.values = config;
  }
}
