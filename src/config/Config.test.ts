import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Config } from './Config.js';

test('Config generates and persists apiToken when missing', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'db-coder-config-test-'));
  const homeDir = join(tempRoot, 'home');
  const projectDir = join(tempRoot, 'project');
  const configDir = join(homeDir, '.db-coder');
  const configPath = join(configDir, 'config.json');
  const previousHome = process.env.HOME;

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ server: { host: '127.0.0.1' } }, null, 2), 'utf-8');

  process.env.HOME = homeDir;

  try {
    const first = new Config(projectDir);
    assert.equal(typeof first.values.apiToken, 'string');
    assert.ok(first.values.apiToken.length > 0);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as { apiToken?: string; server?: { host?: string } };
    assert.equal(persisted.apiToken, first.values.apiToken);
    assert.equal(persisted.server?.host, '127.0.0.1');

    const second = new Config(projectDir);
    assert.equal(second.values.apiToken, first.values.apiToken);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
