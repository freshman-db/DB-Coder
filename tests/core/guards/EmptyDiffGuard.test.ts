import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmptyDiffGuard } from '../../../src/core/guards/EmptyDiffGuard.js';
import type { CycleEvent } from '../../../src/core/CycleEvents.js';

describe('EmptyDiffGuard', () => {
  it('throws when diff is empty', async () => {
    const guard = new EmptyDiffGuard(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }));
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      data: { startCommit: 'abc123' },
      timestamp: Date.now(),
    };
    await assert.rejects(() => guard.handle(event), /no code changes/i);
  });

  it('passes when diff has changes', async () => {
    const guard = new EmptyDiffGuard(async () => ({ filesChanged: 3, insertions: 10, deletions: 2 }));
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      data: { startCommit: 'abc123' },
      timestamp: Date.now(),
    };
    await guard.handle(event);
  });
});
