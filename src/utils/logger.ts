import { createWriteStream, mkdirSync, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};
const RESET = '\x1b[0m';

type LogListener = (entry: LogEntry) => void;

interface LoggerOptions {
  logDir?: string;
  registerExitHandlers?: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export class Logger {
  private minLevel: LogLevel = 'info';
  private readonly logDir: string;
  private readonly logFile: string;
  private readonly logStream: WriteStream;
  private listeners: LogListener[] = [];
  private flushPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private processHandlers?: {
    beforeExit: () => void;
    sigint: () => void;
    sigterm: () => void;
  };

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? join(homedir(), '.db-coder', 'logs');
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.logDir, `${date}.log`);
    this.logStream = createWriteStream(this.logFile, { flags: 'a', encoding: 'utf-8' });
    this.logStream.on('error', (err) => {
      this.writeInternalError('Log stream error', err);
    });

    if (options.registerExitHandlers !== false) {
      this.registerExitHandlers();
    }
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  addListener(listener: LogListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private writeConsole(entry: LogEntry): void {
    const color = LEVEL_COLORS[entry.level];
    const prefix = `${color}[${entry.timestamp}] [${entry.level.toUpperCase()}]${RESET}`;
    console.log(`${prefix} ${entry.message}`);
    if (entry.data !== undefined) console.log(entry.data);
  }

  private writeFile(entry: LogEntry): void {
    if (this.shuttingDown) return;
    try {
      this.logStream.write(JSON.stringify(entry) + '\n');
    } catch (err) {
      this.writeInternalError('Failed to queue log entry for file write', err);
    }
  }

  private writeInternalError(message: string, err: unknown): void {
    if (!this.shouldLog('debug')) return;
    this.writeConsole({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      data: err,
    });
  }

  private registerExitHandlers(): void {
    if (this.processHandlers) return;

    const beforeExit = (): void => {
      void this.flush();
    };
    const sigint = (): void => {
      void this.flushAndExit(130);
    };
    const sigterm = (): void => {
      void this.flushAndExit(143);
    };

    this.processHandlers = { beforeExit, sigint, sigterm };
    process.once('beforeExit', beforeExit);
    process.once('SIGINT', sigint);
    process.once('SIGTERM', sigterm);
  }

  private unregisterExitHandlers(): void {
    if (!this.processHandlers) return;
    process.off('beforeExit', this.processHandlers.beforeExit);
    process.off('SIGINT', this.processHandlers.sigint);
    process.off('SIGTERM', this.processHandlers.sigterm);
    this.processHandlers = undefined;
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    this.shuttingDown = true;
    this.flushPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      this.logStream.once('error', finish);
      this.logStream.end(finish);
    });
    await this.flushPromise;
  }

  async shutdown(): Promise<void> {
    this.unregisterExitHandlers();
    await this.flush();
  }

  private async flushAndExit(code: number): Promise<void> {
    this.unregisterExitHandlers();
    try {
      await this.flush();
    } finally {
      process.exit(code);
    }
  }

  private emit(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    // Terminal output
    this.writeConsole(entry);

    // File output
    this.writeFile(entry);

    // Notify listeners (for SSE streaming)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        this.writeInternalError('Log listener callback failed', err);
      }
    }
  }

  debug(msg: string, data?: unknown): void { this.emit('debug', msg, data); }
  info(msg: string, data?: unknown): void { this.emit('info', msg, data); }
  warn(msg: string, data?: unknown): void { this.emit('warn', msg, data); }
  error(msg: string, data?: unknown): void { this.emit('error', msg, data); }
}

export const log = new Logger();
