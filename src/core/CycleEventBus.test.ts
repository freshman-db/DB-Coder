import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleEventBus } from './CycleEventBus.js';
import type { CycleEvent } from './CycleEvents.js';

function makeEvent(phase: string, timing: string): CycleEvent {
  return { phase: phase as any, timing: timing as any, data: {}, timestamp: Date.now() };
}

describe('CycleEventBus', () => {
  it('emit calls matching handlers synchronously', () => {
    const bus = new CycleEventBus();
    const calls: string[] = [];
    bus.on('after:execute', () => { calls.push('handler1'); });
    bus.on('before:execute', () => { calls.push('handler2'); });

    bus.emit(makeEvent('execute', 'after'));
    assert.deepEqual(calls, ['handler1']);
  });

  it('emitAndWait awaits async handlers', async () => {
    const bus = new CycleEventBus();
    let called = false;
    bus.on('after:verify', async () => {
      await new Promise(r => setTimeout(r, 10));
      called = true;
    });

    const errors = await bus.emitAndWait(makeEvent('verify', 'after'));
    assert.equal(called, true);
    assert.equal(errors.length, 0);
  });

  it('emitAndWait collects handler errors without throwing', async () => {
    const bus = new CycleEventBus();
    bus.on('after:execute', () => { throw new Error('guard failed'); });
    bus.on('after:execute', () => { /* this still runs */ });

    const errors = await bus.emitAndWait(makeEvent('execute', 'after'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'guard failed');
  });

  it('wildcard * matches all events', () => {
    const bus = new CycleEventBus();
    const calls: string[] = [];
    bus.on('*', (e) => { calls.push(`${e.timing}:${e.phase}`); });

    bus.emit(makeEvent('execute', 'after'));
    bus.emit(makeEvent('decide', 'before'));
    assert.deepEqual(calls, ['after:execute', 'before:decide']);
  });

  it('on() returns unsubscribe function', () => {
    const bus = new CycleEventBus();
    const calls: number[] = [];
    const unsub = bus.on('after:execute', () => { calls.push(1); });

    bus.emit(makeEvent('execute', 'after'));
    unsub();
    bus.emit(makeEvent('execute', 'after'));
    assert.deepEqual(calls, [1]);
  });

  it('NoopBus does nothing', () => {
    const bus = CycleEventBus.noop();
    bus.emit(makeEvent('execute', 'after'));
    bus.on('*', () => { throw new Error('should not be called'); });
    bus.emit(makeEvent('execute', 'after'));
  });
});
