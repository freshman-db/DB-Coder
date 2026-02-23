import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuredCycleLogger } from './StructuredCycleLogger.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('StructuredCycleLogger', () => {
  it('records events and exposes log entries', () => {
    const logger = new StructuredCycleLogger();
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      taskId: 'task-1',
      data: { files: 3 },
      timestamp: 1000,
    };
    logger.handle(event);

    const entries = logger.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].phase, 'execute');
    assert.equal(entries[0].timing, 'after');
    assert.equal(entries[0].taskId, 'task-1');
  });

  it('limits buffer to maxEntries', () => {
    const logger = new StructuredCycleLogger(5);
    for (let i = 0; i < 10; i++) {
      logger.handle({ phase: 'execute', timing: 'after', data: { i }, timestamp: i });
    }
    assert.equal(logger.getEntries().length, 5);
    assert.equal(logger.getEntries()[0].data.i, 5);
  });
});
