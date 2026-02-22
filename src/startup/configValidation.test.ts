import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DbCoderConfig } from '../config/types.js';
import { log } from '../utils/logger.js';
import { validateConfigForStartup } from './configValidation.js';

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
    autonomy: { level: 'full', maxRetries: 3, retryBaseDelayMs: 1000, subtaskTimeout: 600 },
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
  const projectPath = mkdtempSync(join(tmpdir(), 'db-coder-startup-config-'));
  try {
    run(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

function withMockedLogError(run: (messages: string[]) => void): void {
  const logger = log as unknown as { error: (message: string, data?: unknown) => void };
  const original = logger.error;
  const messages: string[] = [];
  logger.error = (message: string) => {
    messages.push(message);
  };

  try {
    run(messages);
  } finally {
    logger.error = original;
  }
}

test('validateConfigForStartup returns true when config is valid', () => {
  withTempProject((projectPath) => {
    withMockedLogError((messages) => {
      const isValid = validateConfigForStartup(createValidConfig(), projectPath);

      assert.equal(isValid, true);
      assert.equal(messages.length, 0);
    });
  });
});

test('validateConfigForStartup returns false and logs validation details', () => {
  withTempProject((projectPath) => {
    withMockedLogError((messages) => {
      const config = createValidConfig();
      config.memory.claudeMemUrl = 'ftp://localhost:37777';

      const isValid = validateConfigForStartup(config, projectPath);
      assert.equal(isValid, false);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /Invalid db-coder configuration:/);
      assert.match(messages[0], /memory\.claudeMemUrl must use http: or https: protocol/);
    });
  });
});
