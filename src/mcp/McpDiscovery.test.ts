import assert from 'node:assert/strict';
import test from 'node:test';

import { McpDiscovery } from './McpDiscovery.js';

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
