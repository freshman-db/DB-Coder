import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { McpDiscovery } from '../../src/mcp/McpDiscovery.js';

type ExpandEnvVars = (value: string, installPath?: string) => string | null;

function expandEnvVars(value: string, installPath?: string): string | null {
  const discovery = new McpDiscovery() as unknown as { expandEnvVars: ExpandEnvVars };
  return discovery.expandEnvVars(value, installPath);
}

function restoreEnvVar(key: string, hadPrevious: boolean, previous: string | undefined): void {
  if (hadPrevious && previous !== undefined) {
    process.env[key] = previous;
    return;
  }
  delete process.env[key];
}

test('expandEnvVars expands defined environment variables', () => {
  const key = 'MCP_DISCOVERY_EXPAND_TEST';
  const previous = process.env[key];
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, key);
  process.env[key] = 'token-123';

  try {
    assert.equal(expandEnvVars(`Bearer \${${key}}`), 'Bearer token-123');
  } finally {
    restoreEnvVar(key, hadPrevious, previous);
  }
});

test('expandEnvVars returns null when a referenced variable is missing', () => {
  const key = 'MCP_DISCOVERY_MISSING_TEST';
  const previous = process.env[key];
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, key);
  delete process.env[key];

  try {
    assert.equal(expandEnvVars(`Bearer \${${key}}`), null);
  } finally {
    restoreEnvVar(key, hadPrevious, previous);
  }
});

test('expandEnvVars keeps literal ${...} patterns inside resolved env values', () => {
  const key = 'MCP_DISCOVERY_LITERAL_PATTERN_TEST';
  const previous = process.env[key];
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, key);
  process.env[key] = 'prefix-${NOT_A_VAR}-suffix';

  try {
    assert.equal(
      expandEnvVars(`Value: \${${key}}`),
      'Value: prefix-${NOT_A_VAR}-suffix',
    );
  } finally {
    restoreEnvVar(key, hadPrevious, previous);
  }
});

test('discover loads plugin MCP configs, expands env vars, and routes servers by phase', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-discovery-routing-'));
  const homeDir = join(tempRoot, 'home');
  const claudePluginsDir = join(homeDir, '.claude', 'plugins');
  const installsDir = join(tempRoot, 'installs');
  const serenaInstallPath = join(installsDir, 'serena');
  const docsInstallPath = join(installsDir, 'docs');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');
  const tokenKey = 'MCP_DISCOVERY_TOKEN_TEST';
  const suffixKey = 'MCP_DISCOVERY_SUFFIX_TEST';
  const previousToken = process.env[tokenKey];
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, tokenKey);
  const previousSuffix = process.env[suffixKey];
  const hadSuffix = Object.prototype.hasOwnProperty.call(process.env, suffixKey);

  mkdirSync(claudePluginsDir, { recursive: true });
  mkdirSync(serenaInstallPath, { recursive: true });
  mkdirSync(docsInstallPath, { recursive: true });

  writeFileSync(
    join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        '@team/serena': true,
        '@team/docs': true,
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(claudePluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        '@team/serena': [{ installPath: serenaInstallPath }],
        '@team/docs': [{ installPath: docsInstallPath }],
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(serenaInstallPath, '.mcp.json'),
    JSON.stringify({
      serena: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server.js', '--token', `\${${tokenKey}}`],
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(docsInstallPath, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        docs: {
          type: 'http',
          url: `https://docs.example.com/\${${suffixKey}}`,
          headers: {
            authorization: `Bearer \${${tokenKey}}`,
          },
        },
      },
    }),
    'utf-8',
  );

  process.env.HOME = homeDir;
  process.env[tokenKey] = 'token-123';
  process.env[suffixKey] = 'v1';

  try {
    const discovery = new McpDiscovery({
      enabled: true,
      serverPhases: {
        docs: ['plan', 'review'],
      },
    });

    await discovery.discover();

    assert.deepEqual(discovery.getAllServers().sort(), ['docs', 'serena']);
    assert.deepEqual(discovery.getLoadedPluginIds().sort(), ['@team/docs', '@team/serena']);
    assert.deepEqual(discovery.getServerNames('plan').sort(), ['docs', 'serena']);
    assert.deepEqual(discovery.getServerNames('execute').sort(), ['serena']);
    assert.deepEqual(discovery.getServerNames('review').sort(), ['docs', 'serena']);

    const planServers = discovery.getServersForPhase('plan');
    const serena = planServers.serena as { command?: string; args?: string[] };
    const docs = planServers.docs as {
      type?: string;
      url?: string;
      headers?: Record<string, string>;
    };

    assert.equal(serena.command, 'node');
    assert.deepEqual(serena.args, [join(serenaInstallPath, 'server.js'), '--token', 'token-123']);
    assert.equal(docs.type, 'http');
    assert.equal(docs.url, 'https://docs.example.com/v1');
    assert.equal(docs.headers?.authorization, 'Bearer token-123');
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    restoreEnvVar(tokenKey, hadToken, previousToken);
    restoreEnvVar(suffixKey, hadSuffix, previousSuffix);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('discover skips malformed plugin .mcp.json files without throwing', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-discovery-malformed-'));
  const homeDir = join(tempRoot, 'home');
  const claudePluginsDir = join(homeDir, '.claude', 'plugins');
  const installPath = join(tempRoot, 'installs', 'broken-plugin');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');

  mkdirSync(claudePluginsDir, { recursive: true });
  mkdirSync(installPath, { recursive: true });

  writeFileSync(
    join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        '@team/broken': true,
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(claudePluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        '@team/broken': [{ installPath }],
      },
    }),
    'utf-8',
  );
  writeFileSync(join(installPath, '.mcp.json'), '{not valid json', 'utf-8');

  process.env.HOME = homeDir;

  try {
    const discovery = new McpDiscovery();
    await discovery.discover();
    assert.deepEqual(discovery.getAllServers(), []);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('discover handles missing plugin install directories', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-discovery-missing-install-'));
  const homeDir = join(tempRoot, 'home');
  const claudePluginsDir = join(homeDir, '.claude', 'plugins');
  const missingInstallPath = join(tempRoot, 'installs', 'missing-plugin');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');

  mkdirSync(claudePluginsDir, { recursive: true });
  writeFileSync(
    join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        '@team/missing': true,
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(claudePluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        '@team/missing': [{ installPath: missingInstallPath }],
      },
    }),
    'utf-8',
  );

  process.env.HOME = homeDir;

  try {
    const discovery = new McpDiscovery();
    await discovery.discover();
    assert.deepEqual(discovery.getAllServers(), []);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('discover exits cleanly when Claude plugin metadata files are missing', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-discovery-missing-metadata-'));
  const homeDir = join(tempRoot, 'home');
  const previousHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME');

  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;

  try {
    const discovery = new McpDiscovery();
    await discovery.discover();
    assert.deepEqual(discovery.getAllServers(), []);
  } finally {
    restoreEnvVar('HOME', hadHome, previousHome);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
