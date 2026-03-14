import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuredOutputGuard } from '../../../src/core/guards/StructuredOutputGuard.js';
import type { CycleEvent } from '../../../src/core/CycleEvents.js';

function makeDecideEvent(text: string): CycleEvent {
  return { phase: 'decide', timing: 'after', data: { rawText: text }, timestamp: Date.now() };
}

describe('StructuredOutputGuard', () => {
  it('accepts valid JSON task', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('{"task": "Fix bug in auth", "priority": 1}');
    await guard.handle(event);
  });

  it('accepts plain text that looks like a task description', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('Refactor the auth module to use JWT tokens instead of sessions');
    await guard.handle(event);
  });

  it('rejects conversational text', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('Sure, I think the codebase looks great!');
    await assert.rejects(() => guard.handle(event), /conversational/i);
  });

  it('rejects short text', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('OK');
    await assert.rejects(() => guard.handle(event), /too short/i);
  });
});
