import type { LoopState } from './types.js';
import { log } from '../utils/logger.js';

const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 10_000;
const MAIN_LOOP_STOP_WAIT_BUFFER_MS = 1_000;
const EXECUTION_STATES = new Set<LoopState>(['executing', 'reviewing', 'reflecting']);

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

interface ShutdownProcess {
  on(signal: ShutdownSignal, listener: () => void): void;
  exit(code?: number): void;
}

interface ShutdownMainLoop {
  getCurrentTaskId(): string | null;
  getState(): LoopState;
  stop(): Promise<void>;
  waitForStopped?(timeoutMs?: number): Promise<void>;
}

interface ShutdownServer {
  close(): Promise<void>;
}

interface ShutdownTaskStore {
  updateTask(taskId: string, updates: Record<string, unknown>): Promise<void>;
}

interface ShutdownLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface GracefulShutdownOptions {
  mainLoop: ShutdownMainLoop;
  server: ShutdownServer;
  taskStore: ShutdownTaskStore;
  emitShutdownEvent: (payload: { signal: ShutdownSignal; at: string; message: string }) => void;
  closeDbPool: () => Promise<void>;
  onShutdownComplete?: () => Promise<void>;
  forceExitTimeoutMs?: number;
  processRef?: ShutdownProcess;
  logger?: ShutdownLogger;
}

export class GracefulShutdown {
  private readonly forceExitTimeoutMs: number;
  private readonly processRef: ShutdownProcess;
  private readonly logger: ShutdownLogger;
  private readonly sigtermHandler: () => void;
  private readonly sigintHandler: () => void;

  private shuttingDown = false;
  private registered = false;

  constructor(private readonly options: GracefulShutdownOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('GracefulShutdown requires an options object.');
    }
    if (!options.mainLoop || typeof options.mainLoop.stop !== 'function' || typeof options.mainLoop.getCurrentTaskId !== 'function' || typeof options.mainLoop.getState !== 'function') {
      throw new TypeError('GracefulShutdown requires a mainLoop with stop/getCurrentTaskId/getState methods.');
    }
    if (!options.server || typeof options.server.close !== 'function') {
      throw new TypeError('GracefulShutdown requires a server with a close() method.');
    }
    if (!options.taskStore || typeof options.taskStore.updateTask !== 'function') {
      throw new TypeError('GracefulShutdown requires a taskStore with updateTask().');
    }
    if (typeof options.emitShutdownEvent !== 'function') {
      throw new TypeError('GracefulShutdown requires an emitShutdownEvent() function.');
    }
    if (typeof options.closeDbPool !== 'function') {
      throw new TypeError('GracefulShutdown requires a closeDbPool() function.');
    }
    if (options.processRef && (typeof options.processRef.on !== 'function' || typeof options.processRef.exit !== 'function')) {
      throw new TypeError('processRef must expose on() and exit() methods.');
    }
    if (options.logger && (typeof options.logger.info !== 'function' || typeof options.logger.warn !== 'function' || typeof options.logger.error !== 'function')) {
      throw new TypeError('logger must expose info(), warn(), and error() methods.');
    }

    this.forceExitTimeoutMs = this.resolveForceExitTimeout(options.forceExitTimeoutMs);
    this.processRef = options.processRef ?? process;
    this.logger = options.logger ?? log;
    this.sigtermHandler = () => {
      void this.shutdown('SIGTERM');
    };
    this.sigintHandler = () => {
      void this.shutdown('SIGINT');
    };
  }

  register(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    this.processRef.on('SIGTERM', this.sigtermHandler);
    this.processRef.on('SIGINT', this.sigintHandler);
  }

  async shutdown(signal: ShutdownSignal): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn(`Received ${signal} while shutdown is already in progress. Forcing exit.`);
      this.processRef.exit(1);
      return;
    }
    this.shuttingDown = true;
    this.logger.info(`Received ${signal}. Starting graceful shutdown.`);

    const forceExitTimer = setTimeout(() => {
      this.logger.error(`Graceful shutdown exceeded ${this.forceExitTimeoutMs}ms. Forcing exit.`);
      this.processRef.exit(1);
    }, this.forceExitTimeoutMs);
    forceExitTimer.unref?.();

    const stepFailures: unknown[] = [];
    let closeServerPromise = Promise.resolve();
    try {
      closeServerPromise = this.options.server.close();
    } catch (error) {
      stepFailures.push(error);
      this.logger.error('Initiate HTTP server close failed', error);
    }

    await this.runStep(
      stepFailures,
      'Emit shutdown SSE event',
      async () => {
        this.options.emitShutdownEvent({
          signal,
          at: new Date().toISOString(),
          message: 'server is shutting down',
        });
      },
    );
    await this.runStep(
      stepFailures,
      'Persist in-flight task state',
      async () => {
        await this.persistInFlightTaskState();
      },
    );
    await this.runStep(
      stepFailures,
      'Stop main loop',
      async () => {
        await this.options.mainLoop.stop();
      },
    );
    await this.runStep(
      stepFailures,
      'Wait for main loop shutdown',
      async () => {
        if (typeof this.options.mainLoop.waitForStopped === 'function') {
          const waitTimeoutMs = Math.max(1_000, this.forceExitTimeoutMs - MAIN_LOOP_STOP_WAIT_BUFFER_MS);
          await this.options.mainLoop.waitForStopped(waitTimeoutMs);
        }
      },
    );
    await this.runStep(
      stepFailures,
      'Close DB pool',
      async () => {
        await this.options.closeDbPool();
      },
    );
    await this.runStep(
      stepFailures,
      'Close HTTP server',
      async () => {
        await closeServerPromise;
      },
    );
    await this.runStep(
      stepFailures,
      'Run shutdown finalizer',
      async () => {
        if (typeof this.options.onShutdownComplete === 'function') {
          await this.options.onShutdownComplete();
        }
      },
    );

    clearTimeout(forceExitTimer);
    this.processRef.exit(stepFailures.length === 0 ? 0 : 1);
  }

  private resolveForceExitTimeout(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_FORCE_EXIT_TIMEOUT_MS;
    }
    return value;
  }

  private async persistInFlightTaskState(): Promise<void> {
    const taskId = this.options.mainLoop.getCurrentTaskId();
    if (!taskId) {
      return;
    }

    const state = this.options.mainLoop.getState();
    if (!EXECUTION_STATES.has(state)) {
      return;
    }

    await this.options.taskStore.updateTask(taskId, {
      status: 'interrupted',
      phase: state,
    });
  }

  private async runStep(stepFailures: unknown[], label: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      stepFailures.push(error);
      this.logger.error(`${label} failed`, error);
    }
  }
}
