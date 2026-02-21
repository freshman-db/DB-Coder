import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};
const RESET = '\x1b[0m';

type LogListener = (entry: LogEntry) => void;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

class Logger {
  private minLevel: LogLevel = 'info';
  private logDir: string;
  private logFile: string;
  private listeners: LogListener[] = [];

  constructor() {
    this.logDir = join(homedir(), '.db-coder', 'logs');
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.logDir, `${date}.log`);
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
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (err) {
      if (this.shouldLog('debug')) {
        this.writeConsole({
          timestamp: new Date().toISOString(),
          level: 'debug',
          message: 'Failed to write log entry to file',
          data: err,
        });
      }
    }

    // Notify listeners (for SSE streaming)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        if (this.shouldLog('debug')) {
          this.writeConsole({
            timestamp: new Date().toISOString(),
            level: 'debug',
            message: 'Log listener callback failed',
            data: err,
          });
        }
      }
    }
  }

  debug(msg: string, data?: unknown): void { this.emit('debug', msg, data); }
  info(msg: string, data?: unknown): void { this.emit('info', msg, data); }
  warn(msg: string, data?: unknown): void { this.emit('warn', msg, data); }
  error(msg: string, data?: unknown): void { this.emit('error', msg, data); }
}

export const log = new Logger();
