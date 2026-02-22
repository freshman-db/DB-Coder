import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginMonitor } from './PluginMonitor.js';

function restoreEnvVar(key: string, hadPrevious: boolean, previous: string | undefined): void {
  if (hadPrevious && previous !== undefined) {
    process.env[key] = previous;
    return;
  }
  delete process.env[key];
}

function installFakeClaudeCli(binDir: string, jsonPayload: unknown): void {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'claude');
  const payload = JSON.stringify(jsonPayload);
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "plugin" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then',
    `  printf '%s' '${payload}'`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(scriptPath, script, 'utf-8');
  chmodSync(scriptPath, 0o755);
}

test('PluginMonitor discovers installed plugins and reports new/updatable marketplace plugins', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'plugin-monitor-installed-'));
  const homeDir = join(tempRoot, 'home');
  const pluginsDir = join(homeDir, '.claude', 'plugins');
  const installsDir = join(tempRoot, 'installs');
  const serenaPath = join(installsDir, 'serena');
  const context7Path = join(installsDir, 'context7');
  const binDir = join(tempRoot, 'bin');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');
  const previousPath = process.env.PATH;
  const hadPath = Object.prototype.hasOwnProperty.call(process.env, 'PATH');

  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(serenaPath, { recursive: true });
  mkdirSync(context7Path, { recursive: true });
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        serena: [{ installPath: serenaPath, version: '1.0.0' }],
        context7: [{ installPath: context7Path, version: '0.8.0' }],
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        serena: true,
        context7: false,
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(serenaPath, 'package.json'),
    JSON.stringify({ name: 'serena', description: 'Code review helper' }),
    'utf-8',
  );
  writeFileSync(
    join(context7Path, 'package.json'),
    JSON.stringify({ name: 'context7', description: 'Reference docs plugin' }),
    'utf-8',
  );
  installFakeClaudeCli(binDir, [
    { name: 'serena', version: '1.2.0', description: 'Code review helper' },
    { name: 'feature-dev', version: '0.5.0', description: 'Feature-dev workflow tool' },
  ]);

  process.env.HOME = homeDir;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;

  try {
    const monitor = new PluginMonitor();
    const result = await monitor.checkForUpdates();

    assert.equal(result.installed.length, 2);
    const serena = result.installed.find(plugin => plugin.name === 'serena');
    assert.ok(serena);
    assert.equal(serena.description, 'Code review helper');
    assert.equal(serena.enabled, true);
    assert.equal(serena.hasUpdate, true);

    const context7 = result.installed.find(plugin => plugin.name === 'context7');
    assert.ok(context7);
    assert.equal(context7.enabled, false);

    assert.equal(result.newPlugins.length, 1);
    assert.equal(result.newPlugins[0]?.name, 'feature-dev');
    assert.equal(result.newPlugins[0]?.relevance, 'essential');
    assert.equal(result.available.length, 1);
    assert.equal(result.available[0]?.name, 'feature-dev');
    assert.equal(result.updatable.length, 1);
    assert.equal(result.updatable[0]?.name, 'serena');
    assert.ok(result.checkedAt instanceof Date);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    restoreEnvVar('PATH', hadPath, previousPath);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('PluginMonitor continues when installed plugin JSON is malformed', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'plugin-monitor-malformed-'));
  const homeDir = join(tempRoot, 'home');
  const pluginsDir = join(homeDir, '.claude', 'plugins');
  const binDir = join(tempRoot, 'bin');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');
  const previousPath = process.env.PATH;
  const hadPath = Object.prototype.hasOwnProperty.call(process.env, 'PATH');

  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'installed_plugins.json'), '{not-json', 'utf-8');
  writeFileSync(join(homeDir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {} }), 'utf-8');
  installFakeClaudeCli(binDir, []);

  process.env.HOME = homeDir;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;

  try {
    const monitor = new PluginMonitor();
    const result = await monitor.checkForUpdates();

    assert.equal(result.installed.length, 0);
    assert.equal(result.available.length, 0);
    assert.equal(result.newPlugins.length, 0);
    assert.equal(result.updatable.length, 0);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    restoreEnvVar('PATH', hadPath, previousPath);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('PluginMonitor handles missing Claude plugin directories', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'plugin-monitor-missing-'));
  const homeDir = join(tempRoot, 'home');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');
  const previousPath = process.env.PATH;
  const hadPath = Object.prototype.hasOwnProperty.call(process.env, 'PATH');

  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.PATH = '';

  try {
    const monitor = new PluginMonitor();
    const result = await monitor.checkForUpdates();

    assert.equal(result.installed.length, 0);
    assert.equal(result.available.length, 0);
    assert.equal(result.newPlugins.length, 0);
    assert.equal(result.updatable.length, 0);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    restoreEnvVar('PATH', hadPath, previousPath);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
