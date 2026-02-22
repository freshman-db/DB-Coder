import assert from 'node:assert/strict';
import test from 'node:test';
import { GracefulShutdown, type GracefulShutdownOptions } from './Shutdown.js';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

class MockProcess {
  private listeners = new Map<ShutdownSignal, Set<() => void>>();
  readonly exitCodes: number[] = [];

  on(signal: ShutdownSignal, listener: () => void): void {
    const registered = this.listeners.get(signal) ?? new Set<() => void>();
    registered.add(listener);
    this.listeners.set(signal, registered);
  }

  emit(signal: ShutdownSignal): void {
    const registered = this.listeners.get(signal);
    if (!registered) {
      return;
    }
    for (const listener of registered) {
      listener();
    }
  }

  listenerCount(signal: ShutdownSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }

  exit(code = 0): void {
    this.exitCodes.push(code);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function createLogger(): Pick<Console, 'info' | 'warn' | 'error'> {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createShutdown(
  options: Partial<GracefulShutdownOptions> = {},
): {
  shutdown: GracefulShutdown;
  processRef: MockProcess;
  callOrder: string[];
  updateCalls: Array<{ taskId: string; updates: Record<string, unknown> }>;
} {
  const processRef = new MockProcess();
  const callOrder: string[] = [];
  const updateCalls: Array<{ taskId: string; updates: Record<string, unknown> }> = [];

  const resolvedOptions: GracefulShutdownOptions = {
    mainLoop: {
      getCurrentTaskId: () => null,
      getState: () => 'idle',
      stop: async () => {
        callOrder.push('mainLoop.stop');
      },
      waitForStopped: async () => {
        callOrder.push('mainLoop.waitForStopped');
      },
    },
    server: {
      close: async () => {
        callOrder.push('server.close');
      },
    },
    taskStore: {
      updateTask: async (taskId, updates) => {
        updateCalls.push({ taskId, updates });
        callOrder.push('taskStore.updateTask');
      },
    },
    emitShutdownEvent: () => {
      callOrder.push('emitShutdownEvent');
    },
    closeDbPool: async () => {
      callOrder.push('closeDbPool');
    },
    onShutdownComplete: async () => {
      callOrder.push('onShutdownComplete');
    },
    processRef,
    logger: createLogger(),
    forceExitTimeoutMs: 100,
    ...options,
  };

  const shutdown = new GracefulShutdown(resolvedOptions);
  return { shutdown, processRef, callOrder, updateCalls };
}

test('GracefulShutdown.register wires SIGTERM/SIGINT handlers', async () => {
  const { shutdown, processRef } = createShutdown();

  shutdown.register();
  assert.equal(processRef.listenerCount('SIGTERM'), 1);
  assert.equal(processRef.listenerCount('SIGINT'), 1);

  processRef.emit('SIGINT');
  await sleep(30);
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('GracefulShutdown.shutdown marks active task interrupted and runs cleanup steps', async () => {
  const { shutdown, processRef, callOrder, updateCalls } = createShutdown({
    mainLoop: {
      getCurrentTaskId: () => 'task-42',
      getState: () => 'executing',
      stop: async () => {
        callOrder.push('mainLoop.stop');
      },
      waitForStopped: async () => {
        callOrder.push('mainLoop.waitForStopped');
      },
    },
  });

  await shutdown.shutdown('SIGTERM');

  assert.equal(callOrder[0], 'server.close');
  assert.equal(callOrder[1], 'emitShutdownEvent');
  assert.equal(callOrder[2], 'taskStore.updateTask');
  assert.equal(callOrder[3], 'mainLoop.stop');
  assert.equal(callOrder.includes('closeDbPool'), true);
  assert.equal(callOrder.includes('onShutdownComplete'), true);
  assert.deepEqual(updateCalls, [
    {
      taskId: 'task-42',
      updates: {
        status: 'interrupted',
        phase: 'executing',
      },
    },
  ]);
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('GracefulShutdown calls server.close(), clears timers, and resolves before force-exit timeout', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const forceExitTimerHandle = { id: 'force-exit-timer', unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
  const serverIntervalHandle = { id: 'server-interval' } as unknown as ReturnType<typeof setInterval>;
  let forceExitTimeoutDelay: number | undefined;
  let clearForceExitTimerCalls = 0;
  let clearServerIntervalCalls = 0;
  let serverCloseCalls = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number): ReturnType<typeof setTimeout> => {
    void callback;
    forceExitTimeoutDelay = delay;
    return forceExitTimerHandle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer === forceExitTimerHandle) {
      clearForceExitTimerCalls += 1;
    }
  }) as typeof clearTimeout;
  globalThis.setInterval = ((callback: (...args: unknown[]) => void): ReturnType<typeof setInterval> => {
    void callback;
    return serverIntervalHandle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval> | undefined): void => {
    if (timer === serverIntervalHandle) {
      clearServerIntervalCalls += 1;
    }
  }) as typeof clearInterval;

  try {
    const { shutdown, processRef } = createShutdown({
      server: {
        close: async () => {
          serverCloseCalls += 1;
          const serverInterval = setInterval(() => undefined, 1_000);
          clearInterval(serverInterval);
        },
      },
      forceExitTimeoutMs: 25,
    });

    let timeoutGuard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      shutdown.shutdown('SIGTERM').then(() => 'resolved' as const),
      new Promise<'timed_out'>((resolve) => {
        timeoutGuard = originalSetTimeout(() => resolve('timed_out'), 50);
      }),
    ]);
    if (timeoutGuard !== undefined) {
      originalClearTimeout(timeoutGuard);
    }

    assert.equal(outcome, 'resolved');
    assert.equal(serverCloseCalls, 1);
    assert.equal(forceExitTimeoutDelay, 25);
    assert.equal(clearForceExitTimerCalls, 1);
    assert.equal(clearServerIntervalCalls, 1);
    assert.deepEqual(processRef.exitCodes, [0]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('GracefulShutdown enforces force-exit timeout when server close hangs', async () => {
  const neverResolves = new Promise<void>(() => {});
  const { shutdown, processRef } = createShutdown({
    server: {
      close: async () => neverResolves,
    },
    forceExitTimeoutMs: 20,
  });

  void shutdown.shutdown('SIGTERM');
  await sleep(80);

  assert.equal(processRef.exitCodes.includes(1), true);
});
