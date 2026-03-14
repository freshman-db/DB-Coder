import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins } from '../../src/bridges/pluginDiscovery.js';

describe('discoverPlugins', () => {
  const testDir = join(tmpdir(), `plugin-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent directory', () => {
    const plugins = discoverPlugins('/nonexistent/path');
    assert.deepStrictEqual(plugins, []);
  });

  it('returns empty array for empty directory', () => {
    const plugins = discoverPlugins(testDir);
    assert.deepStrictEqual(plugins, []);
  });

  it('discovers plugins with version directories', () => {
    const pluginDir = join(testDir, 'org-a', 'plugin-1', '1.0.0');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), '{}');

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    assert.strictEqual(plugins[0].type, 'local');
    assert.strictEqual(plugins[0].path, pluginDir);
  });

  it('picks latest version when multiple exist', () => {
    const base = join(testDir, 'org-b', 'plugin-2');
    mkdirSync(join(base, '1.0.0'), { recursive: true });
    mkdirSync(join(base, '2.0.0'), { recursive: true });
    mkdirSync(join(base, '1.5.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    assert.ok(plugins[0].path.endsWith('2.0.0'));
  });

  it('handles double-digit version numbers correctly (semver sort, not string sort)', () => {
    const base = join(testDir, 'org-c', 'plugin-3');
    mkdirSync(join(base, '2.0.0'), { recursive: true });
    mkdirSync(join(base, '10.0.0'), { recursive: true });
    mkdirSync(join(base, '9.1.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    // String sort would pick '9.1.0'; semver sort correctly picks '10.0.0'
    assert.ok(plugins[0].path.endsWith('10.0.0'), `Expected 10.0.0 but got ${plugins[0].path}`);
  });

  it('discovers multiple plugins across orgs', () => {
    mkdirSync(join(testDir, 'org-a', 'p1', '1.0.0'), { recursive: true });
    mkdirSync(join(testDir, 'org-b', 'p2', '1.0.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 2);
  });
});
