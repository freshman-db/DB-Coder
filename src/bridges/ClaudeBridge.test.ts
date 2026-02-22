import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpServerConfig, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../config/types.js';
import { ClaudeBridge } from './ClaudeBridge.js';

type QueryRunner = NonNullable<ConstructorParameters<typeof ClaudeBridge>[2]>;
type QueryInvocation = Parameters<QueryRunner>[0];
type Discovery = NonNullable<ConstructorParameters<typeof ClaudeBridge>[1]>;

function createClaudeConfig(): ClaudeConfig {
  return {
    model: 'sonnet',
    maxTaskBudget: 10,
    maxTurns: 12,
  };
}

function createQueryRunnerSpy(): {
  queryRunner: QueryRunner;
  calls: QueryInvocation[];
  closeCalls: number;
} {
  const calls: QueryInvocation[] = [];
  let closeCalls = 0;

  const queryRunner: QueryRunner = (params: QueryInvocation): Query => {
    calls.push(params);

    async function* emptyStream(): AsyncGenerator<SDKMessage, void, unknown> {
      return;
    }

    const stream = emptyStream();
    return Object.assign(stream, {
      close(): void {
        closeCalls += 1;
      },
    }) as unknown as Query;
  };

  return {
    queryRunner,
    calls,
    get closeCalls() {
      return closeCalls;
    },
  };
}

function createDiscovery(servers: Record<string, McpServerConfig>): Discovery {
  return {
    getServersForPhase(phase: 'plan') {
      assert.equal(phase, 'plan');
      return servers;
    },
    getPluginsForPhase(phase: 'plan') {
      assert.equal(phase, 'plan');
      return [];
    },
  } as unknown as Discovery;
}

test('createChatSession merges discovered and internal MCP servers before query starts', () => {
  const discoveredServers: Record<string, McpServerConfig> = {
    discovery_only: { command: 'discovery-command', args: ['--stdio'] },
    shared: { command: 'shared-discovery-command' },
  };
  const internalServers: Record<string, McpServerConfig> = {
    internal_only: { command: 'internal-command' },
    shared: { command: 'shared-internal-command' },
  };
  const querySpy = createQueryRunnerSpy();
  const bridge = new ClaudeBridge(
    createClaudeConfig(),
    createDiscovery(discoveredServers),
    querySpy.queryRunner,
  );

  const session = bridge.createChatSession('/workspace/project', () => {}, {
    internalMcpServers: internalServers,
  });

  assert.equal(querySpy.calls.length, 1);
  assert.deepEqual(querySpy.calls[0].options?.mcpServers, {
    discovery_only: { command: 'discovery-command', args: ['--stdio'] },
    shared: { command: 'shared-internal-command' },
    internal_only: { command: 'internal-command' },
  });

  session.close();
  assert.equal(querySpy.closeCalls, 1);
});

test('createChatSession keeps discovered MCP servers when no internal map is provided', () => {
  const discoveredServers: Record<string, McpServerConfig> = {
    external_a: { command: 'external-a' },
    external_b: { command: 'external-b', args: ['--stdio'] },
  };
  const querySpy = createQueryRunnerSpy();
  const bridge = new ClaudeBridge(
    createClaudeConfig(),
    createDiscovery(discoveredServers),
    querySpy.queryRunner,
  );

  const session = bridge.createChatSession('/workspace/project', () => {});

  assert.equal(querySpy.calls.length, 1);
  assert.deepEqual(querySpy.calls[0].options?.mcpServers, discoveredServers);

  session.close();
  assert.equal(querySpy.closeCalls, 1);
});

test('createChatSession supports internal MCP servers when discovery is unavailable', () => {
  const internalServers: Record<string, McpServerConfig> = {
    db_coder_internal: { command: 'internal-only-command' },
  };
  const querySpy = createQueryRunnerSpy();
  const bridge = new ClaudeBridge(createClaudeConfig(), undefined, querySpy.queryRunner);

  const session = bridge.createChatSession('/workspace/project', () => {}, {
    internalMcpServers: internalServers,
  });

  assert.equal(querySpy.calls.length, 1);
  assert.deepEqual(querySpy.calls[0].options?.mcpServers, internalServers);

  session.close();
  assert.equal(querySpy.closeCalls, 1);
});

test('createChatSession omits mcpServers when both discovered and internal maps are empty', () => {
  const querySpy = createQueryRunnerSpy();
  const bridge = new ClaudeBridge(createClaudeConfig(), createDiscovery({}), querySpy.queryRunner);

  const session = bridge.createChatSession('/workspace/project', () => {}, {
    internalMcpServers: {},
  });

  assert.equal(querySpy.calls.length, 1);
  const options = querySpy.calls[0].options ?? {};
  assert.equal(Object.hasOwn(options, 'mcpServers'), false);

  session.close();
  assert.equal(querySpy.closeCalls, 1);
});
