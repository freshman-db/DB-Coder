import assert from 'node:assert/strict';
import test from 'node:test';
import { wireGracefulShutdown, type WireGracefulShutdownOptions } from './gracefulShutdown.js';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

class MockProcess {
  private listeners = new Map<ShutdownSignal, Set<() => void>>();
  private exitWaiters: Array<(code: number) => void> = [];
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

  waitForExit(timeoutMs = 500): Promise<number> {
    const latest = this.exitCodes.at(-1);
    if (latest !== undefined) {
      return Promise.resolve(latest);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for process.exit()'));
      }, timeoutMs);
      this.exitWaiters.push((code: number) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  }

  exit(code = 0): void {
    this.exitCodes.push(code);
    for (const waiter of this.exitWaiters.splice(0)) {
      waiter(code);
    }
  }
}

function createLogger(): Required<WireGracefulShutdownOptions>['logger'] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createValidOptions(processRef: MockProcess, callOrder: string[]): WireGracefulShutdownOptions {
  return {
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
    server: {
      stop: async () => {
        callOrder.push('server.stop');
      },
    },
    taskStore: {
      updateTask: async () => {
        callOrder.push('taskStore.updateTask');
      },
      close: async () => {
        callOrder.push('taskStore.close');
      },
    },
    globalMemory: {
      close: async () => {
        callOrder.push('globalMemory.close');
      },
    },
    processRef,
    logger: createLogger(),
  };
}

test('wireGracefulShutdown registers SIGTERM/SIGINT handlers and delegates shutdown flow', async () => {
  const processRef = new MockProcess();
  const callOrder: string[] = [];
  const updateCalls: Array<{ taskId: string; updates: Record<string, unknown> }> = [];
  const payloads: Array<{ signal: ShutdownSignal; at: string; message: string }> = [];

  const options = createValidOptions(processRef, callOrder);
  options.taskStore = {
    updateTask: async (taskId, updates) => {
      updateCalls.push({ taskId, updates });
      callOrder.push('taskStore.updateTask');
    },
    close: async () => {
      callOrder.push('taskStore.close');
    },
  };
  options.emitShutdownEvent = (payload) => {
    payloads.push(payload);
    callOrder.push('emitShutdownEvent');
  };
  options.onShutdownComplete = async () => {
    callOrder.push('onShutdownComplete');
  };

  wireGracefulShutdown(options);

  assert.equal(processRef.listenerCount('SIGTERM'), 1);
  assert.equal(processRef.listenerCount('SIGINT'), 1);

  const exitPromise = processRef.waitForExit();
  processRef.emit('SIGTERM');
  const exitCode = await exitPromise;

  assert.equal(exitCode, 0);
  assert.deepEqual(callOrder, [
    'server.stop',
    'emitShutdownEvent',
    'taskStore.updateTask',
    'mainLoop.stop',
    'mainLoop.waitForStopped',
    'globalMemory.close',
    'taskStore.close',
    'onShutdownComplete',
  ]);
  assert.deepEqual(updateCalls, [
    {
      taskId: 'task-42',
      updates: {
        status: 'interrupted',
        phase: 'executing',
      },
    },
  ]);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.signal, 'SIGTERM');
  assert.equal(payloads[0]?.message, 'server is shutting down');
  assert.equal(typeof payloads[0]?.at, 'string');
});

test('wireGracefulShutdown validates required references', () => {
  const processRef = new MockProcess();
  const callOrder: string[] = [];
  const options = createValidOptions(processRef, callOrder);

  assert.throws(() => {
    wireGracefulShutdown({
      ...options,
      server: {} as WireGracefulShutdownOptions['server'],
    });
  }, /server with stop/);
});
