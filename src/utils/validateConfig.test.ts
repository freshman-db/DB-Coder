import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DbCoderConfig } from '../config/types.js';
import { ConfigValidationError, validateConfig } from './validateConfig.js';

function createValidConfig(): DbCoderConfig {
  return {
    apiToken: 'test-token',
    brain: { model: 'opus', scanInterval: 3600, maxScanBudget: 1.0 },
    claude: { model: 'opus', maxTaskBudget: 2.0, maxTurns: 30 },
    codex: {
      model: 'gpt-5.3-codex',
      sandbox: 'workspace-write',
      tokenPricing: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
    },
    autonomy: { level: 'full', maxRetries: 3, subtaskTimeout: 600 },
    routing: {
      scan: 'brain',
      plan: 'brain',
      execute_frontend: 'claude',
      execute_backend: 'codex',
      review: ['claude', 'codex'],
      reflect: 'brain',
    },
    budget: { maxPerTask: 5.0, maxPerDay: 200.0, warningThreshold: 0.8 },
    memory: {
      claudeMemUrl: 'http://localhost:37777',
      pgConnectionString: 'postgresql://db:db@localhost:5432/db_coder',
    },
    git: { branchPrefix: 'db-coder/', protectedBranches: ['main', 'master'] },
    server: { host: '127.0.0.1', port: 18800 },
    mcp: { enabled: true },
    plugins: {},
    evolution: {
      goals: [{ description: 'Keep code quality high', priority: 1, status: 'active' }],
    },
  };
}

function withTempProject(run: (projectPath: string) => void): void {
  const projectPath = mkdtempSync(join(tmpdir(), 'db-coder-validate-config-'));
  try {
    run(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

function assertValidationIssue(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    if (!(err instanceof ConfigValidationError)) return false;
    return err.issues.some(issue => pattern.test(issue));
  });
}

test('validateConfig accepts a valid config', () => {
  withTempProject((projectPath) => {
    assert.doesNotThrow(() => validateConfig(createValidConfig(), projectPath));
  });
});

test('validateConfig rejects negative budget values', () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.budget.maxPerTask = -1;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /budget\.maxPerTask must be >= 0/,
    );
  });
});

test('validateConfig rejects empty required strings', () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.memory.pgConnectionString = '   ';

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /memory\.pgConnectionString must be a non-empty string/,
    );
  });
});

test('validateConfig rejects invalid server port numbers', () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.server.port = 70000;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /server\.port must be <= 65535/,
    );
  });
});

test('validateConfig rejects missing project paths', () => {
  const missingPath = join(tmpdir(), `db-coder-missing-${Date.now()}`);
  assertValidationIssue(
    () => validateConfig(createValidConfig(), missingPath),
    /projectPath does not exist/,
  );
});
