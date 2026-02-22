import type { MainLoop } from '../core/MainLoop.js';
import { GracefulShutdown } from '../core/Shutdown.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { Server } from '../server/Server.js';
import { emitSseEvent } from '../server/routes.js';
import { log } from '../utils/logger.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

type ShutdownPayload = {
  signal: ShutdownSignal;
  at: string;
  message: string;
};

interface ShutdownProcessRef {
  on(signal: ShutdownSignal, listener: () => void): void;
  exit(code?: number): void;
}

interface ShutdownLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface WireGracefulShutdownOptions {
  mainLoop: Pick<MainLoop, 'getCurrentTaskId' | 'getState' | 'stop' | 'waitForStopped'>;
  server: Pick<Server, 'stop'>;
  taskStore: Pick<TaskStore, 'updateTask' | 'close'>;
  globalMemory: Pick<GlobalMemory, 'close'>;
  processRef?: ShutdownProcessRef;
  emitShutdownEvent?: (payload: ShutdownPayload) => void;
  onShutdownComplete?: () => Promise<void>;
  logger?: ShutdownLogger;
}

function hasMethod(value: unknown, method: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[method] === 'function';
}

export function wireGracefulShutdown(options: WireGracefulShutdownOptions): GracefulShutdown {
  if (!options || typeof options !== 'object') {
    throw new TypeError('wireGracefulShutdown requires an options object.');
  }
  if (!hasMethod(options.mainLoop, 'stop') || !hasMethod(options.mainLoop, 'getCurrentTaskId') || !hasMethod(options.mainLoop, 'getState')) {
    throw new TypeError('wireGracefulShutdown requires mainLoop with stop/getCurrentTaskId/getState methods.');
  }
  if (!hasMethod(options.server, 'stop')) {
    throw new TypeError('wireGracefulShutdown requires server with stop().');
  }
  if (!hasMethod(options.taskStore, 'updateTask') || !hasMethod(options.taskStore, 'close')) {
    throw new TypeError('wireGracefulShutdown requires taskStore with updateTask()/close().');
  }
  if (!hasMethod(options.globalMemory, 'close')) {
    throw new TypeError('wireGracefulShutdown requires globalMemory with close().');
  }
  if (options.processRef && (!hasMethod(options.processRef, 'on') || !hasMethod(options.processRef, 'exit'))) {
    throw new TypeError('processRef must expose on() and exit() methods.');
  }
  if (options.emitShutdownEvent !== undefined && typeof options.emitShutdownEvent !== 'function') {
    throw new TypeError('emitShutdownEvent must be a function when provided.');
  }
  if (options.onShutdownComplete !== undefined && typeof options.onShutdownComplete !== 'function') {
    throw new TypeError('onShutdownComplete must be a function when provided.');
  }

  const processRef = options.processRef ?? process;
  const emitShutdownEvent = options.emitShutdownEvent ?? ((payload: ShutdownPayload) => {
    emitSseEvent('shutdown', payload);
  });
  const onShutdownComplete = options.onShutdownComplete ?? (async () => {
    await log.shutdown();
  });

  const shutdown = new GracefulShutdown({
    mainLoop: options.mainLoop,
    server: {
      close: async () => {
        await options.server.stop();
      },
    },
    taskStore: options.taskStore,
    emitShutdownEvent,
    closeDbPool: async () => {
      await options.globalMemory.close();
      await options.taskStore.close();
    },
    onShutdownComplete,
    processRef,
    logger: options.logger,
  });

  processRef.on('SIGTERM', () => {
    void shutdown.shutdown('SIGTERM');
  });
  processRef.on('SIGINT', () => {
    void shutdown.shutdown('SIGINT');
  });

  return shutdown;
}
