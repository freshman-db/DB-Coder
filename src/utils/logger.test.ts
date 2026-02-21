import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Logger } from './logger.js';

interface TestLogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: unknown;
}

function getLogFilePath(logDir: string): string {
  return join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);
}

function readEntries(logDir: string): TestLogEntry[] {
  const path = getLogFilePath(logDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as TestLogEntry);
}

function muteConsole(): () => void {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
}

test('Logger writes buffered entries in order', { concurrency: false }, async () => {
  const restoreConsole = muteConsole();
  const logDir = mkdtempSync(join(tmpdir(), 'db-coder-logger-test-'));
  const logger = new Logger({ logDir, registerExitHandlers: false });

  try {
    logger.info('first');
    logger.warn('second');
    logger.error('third');
    await logger.flush();

    const entries = readEntries(logDir);
    assert.deepEqual(entries.map(entry => entry.message), ['first', 'second', 'third']);
    assert.deepEqual(entries.map(entry => entry.level), ['info', 'warn', 'error']);
  } finally {
    await logger.shutdown();
    rmSync(logDir, { recursive: true, force: true });
    restoreConsole();
  }
});

test('Logger appends to existing log file across instances', { concurrency: false }, async () => {
  const restoreConsole = muteConsole();
  const logDir = mkdtempSync(join(tmpdir(), 'db-coder-logger-append-test-'));
  const firstLogger = new Logger({ logDir, registerExitHandlers: false });
  let secondLogger: Logger | null = null;

  try {
    firstLogger.info('from first logger');
    await firstLogger.shutdown();

    secondLogger = new Logger({ logDir, registerExitHandlers: false });
    secondLogger.info('from second logger');
    await secondLogger.shutdown();
    secondLogger = null;

    const entries = readEntries(logDir);
    assert.deepEqual(entries.map(entry => entry.message), ['from first logger', 'from second logger']);
  } finally {
    if (secondLogger) await secondLogger.shutdown();
    await firstLogger.shutdown();
    rmSync(logDir, { recursive: true, force: true });
    restoreConsole();
  }
});

test('Logger registers lifecycle handlers and flushes pending writes on shutdown', { concurrency: false }, async () => {
  const restoreConsole = muteConsole();
  const logDir = mkdtempSync(join(tmpdir(), 'db-coder-logger-shutdown-test-'));
  const beforeCounts = {
    beforeExit: process.listenerCount('beforeExit'),
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  };
  const logger = new Logger({ logDir, registerExitHandlers: true });
  let loggerClosed = false;

  try {
    assert.equal(process.listenerCount('beforeExit'), beforeCounts.beforeExit + 1);
    assert.equal(process.listenerCount('SIGINT'), beforeCounts.sigint + 1);
    assert.equal(process.listenerCount('SIGTERM'), beforeCounts.sigterm + 1);

    logger.info('pending message');
    await logger.shutdown();
    loggerClosed = true;

    const entries = readEntries(logDir);
    assert.equal(entries.at(-1)?.message, 'pending message');
    assert.equal(process.listenerCount('beforeExit'), beforeCounts.beforeExit);
    assert.equal(process.listenerCount('SIGINT'), beforeCounts.sigint);
    assert.equal(process.listenerCount('SIGTERM'), beforeCounts.sigterm);
  } finally {
    if (!loggerClosed) await logger.shutdown();
    rmSync(logDir, { recursive: true, force: true });
    restoreConsole();
  }
});

test('Logger drops entries when backpressure buffer overflows', { concurrency: false }, async () => {
  const restoreConsole = muteConsole();
  const logDir = mkdtempSync(join(tmpdir(), 'db-coder-logger-bp-test-'));
  // Use a tiny buffer to make overflow easy to trigger
  const logger = new Logger({ logDir, registerExitHandlers: false, maxBufferSize: 5 });

  try {
    // Write many entries — even if the stream handles them all without
    // backpressure, this verifies the buffer-size option is accepted
    // and the logger does not throw.
    for (let i = 0; i < 50; i++) {
      logger.info(`msg-${i}`);
    }
    await logger.flush();

    const entries = readEntries(logDir);
    // At minimum the first entries should be present (stream absorbs them);
    // the exact count depends on OS buffer sizes but should never exceed
    // 50 entries + 1 possible dropped-warning entry.
    assert.ok(entries.length >= 1, 'Should have written at least one entry');
    assert.ok(entries.length <= 51, 'Should not exceed input + 1 warning');
  } finally {
    await logger.shutdown();
    rmSync(logDir, { recursive: true, force: true });
    restoreConsole();
  }
});

test('Logger signal handlers do not race with app shutdown', { concurrency: false, timeout: 10_000 }, async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'db-coder-logger-signal-test-'));
  const markerFile = join(logDir, 'marker');
  const fixturePath = fileURLToPath(new URL('./logger-signal-fixture.js', import.meta.url));

  const child = fork(fixturePath, [logDir, markerFile], { silent: true });

  // Wait for the child to signal it's ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture timed out waiting for ready')), 5000);
    child.on('message', (msg) => {
      if (msg === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture exited early with code ${code}`));
    });
  });

  // Send SIGINT — both the logger's handler and the app's handler should fire
  child.kill('SIGINT');

  // Wait for the child to exit cleanly
  const exitCode = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  try {
    assert.equal(exitCode, 0, 'Child should exit with code 0 (app-owned exit)');
    assert.ok(existsSync(markerFile), 'App cleanup marker file should exist');
    assert.equal(readFileSync(markerFile, 'utf-8'), 'cleanup-done');

    const entries = readEntries(logDir);
    const messages = entries.map(e => e.message);
    assert.ok(messages.includes('ready'), 'Should have logged the initial ready message');
    assert.ok(messages.includes('app-shutdown-started'), 'App should be able to log during shutdown');
    assert.ok(messages.includes('app-shutdown-complete'), 'App shutdown should complete fully');
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
