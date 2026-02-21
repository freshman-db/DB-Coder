import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const raw = readFileSync(getLogFilePath(logDir), 'utf-8').trim();
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
