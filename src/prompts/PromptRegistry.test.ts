import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskStore } from '../memory/TaskStore.js';
import type { PromptVersion } from '../evolution/types.js';
import { log } from '../utils/logger.js';
import { PromptRegistry } from './PromptRegistry.js';

const PROJECT_PATH = '/tmp/project';
const BASE_PROMPT = `You are a scanner.

## Instructions
Inspect the repository thoroughly.

## Output Format
{
  "issues": [],
  "projectHealth": 50
}`;

function makePromptVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: 1,
    project_path: PROJECT_PATH,
    prompt_name: 'scan',
    version: 1,
    patches: [],
    rationale: 'test rationale',
    confidence: 0.8,
    effectiveness: 0,
    status: 'active',
    baseline_metrics: null,
    current_metrics: null,
    tasks_evaluated: 0,
    activated_at: new Date('2026-01-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockDateNow(initial: number): { set: (next: number) => void; restore: () => void } {
  const originalDateNow = Date.now;
  let now = initial;
  Date.now = () => now;
  return {
    set: (next: number) => {
      now = next;
    },
    restore: () => {
      Date.now = originalDateNow;
    },
  };
}

describe('PromptRegistry', () => {
  it('resolve() returns base prompt unchanged when no active version exists', async () => {
    const taskStore = {
      getActivePromptVersions: async () => [],
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    const resolved = await registry.resolve('scan', BASE_PROMPT);

    assert.equal(resolved, BASE_PROMPT);
  });

  it('resolve() applies active prompt patches when they are valid', async () => {
    const taskStore = {
      getActivePromptVersions: async () => [
        makePromptVersion({
          patches: [{ op: 'append', content: 'Keep findings concise.', reason: 'style' }],
        }),
      ],
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    const resolved = await registry.resolve('scan', BASE_PROMPT);

    assert.notEqual(resolved, BASE_PROMPT);
    assert.ok(resolved.endsWith('Keep findings concise.'));
  });

  it('resolve() falls back to base and logs warn when patches cannot be applied', async () => {
    const warnings: string[] = [];
    const originalWarn = log.warn;
    log.warn = (message: string): void => {
      warnings.push(message);
    };

    try {
      const taskStore = {
        getActivePromptVersions: async () => [
          makePromptVersion({
            patches: [{ op: 'replace_section', section: 'Missing Section', content: 'broken', reason: 'test' }],
          }),
        ],
      } as unknown as TaskStore;
      const registry = new PromptRegistry(taskStore, PROJECT_PATH);

      const resolved = await registry.resolve('scan', BASE_PROMPT);

      assert.equal(resolved, BASE_PROMPT);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Prompt patch failed/);
    } finally {
      log.warn = originalWarn;
    }
  });

  it('resolve() falls back to base and logs warn when patched prompt breaks format validation', async () => {
    const warnings: string[] = [];
    const originalWarn = log.warn;
    log.warn = (message: string): void => {
      warnings.push(message);
    };

    try {
      const taskStore = {
        getActivePromptVersions: async () => [
          makePromptVersion({
            patches: [{ op: 'replace_section', section: 'Output Format', content: 'Respond in plain text.', reason: 'test' }],
          }),
        ],
      } as unknown as TaskStore;
      const registry = new PromptRegistry(taskStore, PROJECT_PATH);

      const resolved = await registry.resolve('scan', BASE_PROMPT);

      assert.equal(resolved, BASE_PROMPT);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /broke JSON format/);
    } finally {
      log.warn = originalWarn;
    }
  });

  it('uses cached versions for repeated resolve() calls within TTL', async () => {
    const clock = mockDateNow(1_000);
    let callCount = 0;
    const taskStore = {
      getActivePromptVersions: async () => {
        callCount++;
        return [makePromptVersion()];
      },
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    try {
      await registry.resolve('scan', BASE_PROMPT);
      clock.set(1_000 + 59_000);
      await registry.resolve('scan', BASE_PROMPT);
      assert.equal(callCount, 1);
    } finally {
      clock.restore();
    }
  });

  it('re-fetches active versions when cache TTL expires', async () => {
    const clock = mockDateNow(10_000);
    let callCount = 0;
    const taskStore = {
      getActivePromptVersions: async () => {
        callCount++;
        return [makePromptVersion()];
      },
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    try {
      await registry.resolve('scan', BASE_PROMPT);
      clock.set(10_000 + 60_001);
      await registry.resolve('scan', BASE_PROMPT);
      assert.equal(callCount, 2);
    } finally {
      clock.restore();
    }
  });

  it('getActiveVersionId() returns version id when found and null when absent', async () => {
    const taskStore = {
      getActivePromptVersions: async () => [
        makePromptVersion({ id: 42, prompt_name: 'scan' }),
      ],
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    const existing = await registry.getActiveVersionId('scan');
    const missing = await registry.getActiveVersionId('plan');

    assert.equal(existing, 42);
    assert.equal(missing, null);
  });

  it('refresh() reloads versions regardless of cache age', async () => {
    const clock = mockDateNow(100_000);
    let callCount = 0;
    const taskStore = {
      getActivePromptVersions: async () => {
        callCount++;
        return [makePromptVersion({ id: callCount })];
      },
    } as unknown as TaskStore;
    const registry = new PromptRegistry(taskStore, PROJECT_PATH);

    try {
      await registry.resolve('scan', BASE_PROMPT);
      clock.set(100_000 + 1_000);
      await registry.refresh();
      await registry.resolve('scan', BASE_PROMPT);
      assert.equal(callCount, 2);
    } finally {
      clock.restore();
    }
  });
});
