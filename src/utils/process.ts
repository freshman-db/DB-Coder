import { spawn, type ChildProcess } from 'node:child_process';
import { log } from './logger.js';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface JsonlEvent {
  type: string;
  [key: string]: unknown;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    input?: string;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    if (options.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }

    const timer = options.timeout
      ? setTimeout(() => { killed = true; child.kill('SIGTERM'); }, options.timeout)
      : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        resolve({ exitCode: -1, stdout, stderr: stderr + '\n[TIMEOUT]' });
      } else {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      }
    });
  });
}

export function parseJsonlEvents(output: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      log.debug('Skipping non-JSON line in process output', { error: err, line: trimmed });
    }
  }
  return events;
}

export function spawnWithJsonl(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    onEvent?: (event: JsonlEvent) => void;
  } = {},
): Promise<{ exitCode: number; events: JsonlEvent[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let buffer = '';
    const events: JsonlEvent[] = [];
    let killed = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as JsonlEvent;
          events.push(event);
          options.onEvent?.(event);
        } catch (err) {
          log.debug('Skipping non-JSON line in JSONL stream', { error: err, line: trimmed });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = options.timeout
      ? setTimeout(() => { killed = true; child.kill('SIGTERM'); }, options.timeout)
      : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: killed ? -1 : (code ?? 0), events, stderr });
    });
  });
}
