import {
  createWriteStream,
  mkdirSync,
  existsSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

/** Maximum entries held in the backpressure buffer before dropping */
const DEFAULT_MAX_BUFFER_SIZE = 1000;
/** Maximum recent log entries kept in memory for instant replay on SSE connect */
const RECENT_ENTRIES_CAPACITY = 200;

type LogListener = (entry: LogEntry) => void;

interface LoggerOptions {
  logDir?: string;
  registerExitHandlers?: boolean;
  /** Maximum entries in the backpressure buffer before dropping (default: 1000) */
  maxBufferSize?: number;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export class Logger {
  private minLevel: LogLevel = "info";
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

  /* Recent entries ring buffer for instant SSE replay */
  private recentEntries: LogEntry[] = [];

  /* Backpressure state */
  private writeBuffer: string[] = [];
  private draining = false;
  private readonly maxBufferSize: number;
  private droppedCount = 0;

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? join(homedir(), ".db-coder", "logs");
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.logDir, `${date}.log`);
    this.logStream = createWriteStream(this.logFile, {
      flags: "a",
      encoding: "utf-8",
    });
    this.logStream.on("error", (err) => {
      this.writeInternalError("Log stream error", err);
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
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getRecentEntries(limit = RECENT_ENTRIES_CAPACITY): LogEntry[] {
    const n = Math.min(limit, this.recentEntries.length);
    return this.recentEntries.slice(-n);
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
    const line = JSON.stringify(entry) + "\n";

    if (this.draining) {
      this.enqueueLine(line);
      return;
    }

    try {
      const ok = this.logStream.write(line);
      if (!ok) {
        this.draining = true;
        this.logStream.once("drain", () => this.onDrain());
      }
    } catch (err) {
      this.writeInternalError("Failed to queue log entry for file write", err);
    }
  }

  /** Enqueue a serialized line in the bounded backpressure buffer. */
  private enqueueLine(line: string): void {
    if (this.writeBuffer.length >= this.maxBufferSize) {
      this.droppedCount++;
      return;
    }
    this.writeBuffer.push(line);
  }

  /** Called when the stream signals it can accept more data. */
  private onDrain(): void {
    this.draining = false;

    if (this.droppedCount > 0) {
      const dropped = this.droppedCount;
      this.droppedCount = 0;
      const warnLine =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: `Logger dropped ${dropped} entries due to backpressure`,
        }) + "\n";
      this.writeBuffer.unshift(warnLine);
    }

    this.drainBackpressureBuffer();
  }

  /**
   * Write buffered entries to the stream without ending it.
   * Safe to call from signal handlers — does not affect future writes.
   */
  private drainBackpressureBuffer(): void {
    while (this.writeBuffer.length > 0) {
      const line = this.writeBuffer.shift()!;
      try {
        const ok = this.logStream.write(line);
        if (!ok) {
          this.draining = true;
          this.logStream.once("drain", () => this.onDrain());
          return;
        }
      } catch {
        break;
      }
    }
  }

  private writeInternalError(message: string, err: unknown): void {
    if (!this.shouldLog("debug")) return;
    this.writeConsole({
      timestamp: new Date().toISOString(),
      level: "debug",
      message,
      data: err,
    });
  }

  private registerExitHandlers(): void {
    if (this.processHandlers) return;

    const beforeExit = (): void => {
      void this.flush();
    };
    // Signal handlers only drain the backpressure buffer — they do NOT
    // end the stream or call process.exit(). The application owns
    // process lifecycle and should call logger.shutdown() explicitly.
    const onSignal = (): void => {
      this.drainBackpressureBuffer();
    };

    this.processHandlers = { beforeExit, sigint: onSignal, sigterm: onSignal };
    process.once("beforeExit", beforeExit);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  private unregisterExitHandlers(): void {
    if (!this.processHandlers) return;
    process.off("beforeExit", this.processHandlers.beforeExit);
    process.off("SIGINT", this.processHandlers.sigint);
    process.off("SIGTERM", this.processHandlers.sigterm);
    this.processHandlers = undefined;
  }

  /**
   * Flush all pending writes and close the log stream.
   * After calling this, no more entries will be written to file.
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    this.shuttingDown = true;

    // Write any buffered entries directly (ignoring backpressure since
    // we are about to end the stream, which will flush the OS buffer).
    while (this.writeBuffer.length > 0) {
      const line = this.writeBuffer.shift()!;
      try {
        this.logStream.write(line);
      } catch {
        break;
      }
    }

    this.flushPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      this.logStream.once("error", finish);
      this.logStream.end(finish);
    });
    await this.flushPromise;
  }

  /**
   * Unregister process handlers and flush all pending writes.
   * Call this from the application's shutdown path as the last step
   * before process.exit().
   */
  async shutdown(): Promise<void> {
    this.unregisterExitHandlers();
    await this.flush();
  }

  private emit(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    // Ring buffer for instant SSE replay
    this.recentEntries.push(entry);
    if (this.recentEntries.length > RECENT_ENTRIES_CAPACITY) {
      this.recentEntries.shift();
    }

    // Terminal output
    this.writeConsole(entry);

    // File output
    this.writeFile(entry);

    // Notify listeners (for SSE streaming)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        this.writeInternalError("Log listener callback failed", err);
      }
    }
  }

  debug(msg: string, data?: unknown): void {
    this.emit("debug", msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.emit("info", msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.emit("warn", msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.emit("error", msg, data);
  }
}

export const log = new Logger();
