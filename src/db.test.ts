import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { closeDb, getDb, resetDbForTesting } from './db.js';
import { GlobalMemory } from './memory/GlobalMemory.js';
import { TaskStore } from './memory/TaskStore.js';

const PRIMARY_DSN = 'postgres://db-coder:db-coder@127.0.0.1:5432/db_coder_test';
const OTHER_DSN = 'postgres://db-coder:db-coder@127.0.0.1:5432/db_coder_other';

function getStoreSql(instance: GlobalMemory | TaskStore): unknown {
  return (instance as unknown as { sql: unknown }).sql;
}

async function runInTestEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    return await fn();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

beforeEach(async () => {
  await runInTestEnv(async () => resetDbForTesting());
});

afterEach(async () => {
  await runInTestEnv(async () => resetDbForTesting());
});

test('GlobalMemory and TaskStore share one pool for the same connection string', { concurrency: false }, async () => {
  const globalMemory = new GlobalMemory(PRIMARY_DSN);
  const taskStore = new TaskStore(PRIMARY_DSN);

  assert.equal(getStoreSql(globalMemory), getStoreSql(taskStore));

  await globalMemory.close();
  await taskStore.close();
});

test('shared pool rejects a second connection string', { concurrency: false }, async () => {
  const globalMemory = new GlobalMemory(PRIMARY_DSN);

  assert.throws(() => new TaskStore(OTHER_DSN), /different connection string/);

  await globalMemory.close();
});

test('pool stays available until all consumers release it', { concurrency: false }, async () => {
  const globalMemory = new GlobalMemory(PRIMARY_DSN);
  const taskStore = new TaskStore(PRIMARY_DSN);
  const taskStoreSql = getStoreSql(taskStore);

  await globalMemory.close();
  await globalMemory.close();

  const extraLease = getDb(PRIMARY_DSN);
  assert.equal(extraLease, taskStoreSql);

  await closeDb();
  await taskStore.close();

  assert.throws(() => getDb(PRIMARY_DSN), /Cannot acquire DB after shutdown/);
});

test('resetDbForTesting requires NODE_ENV=test', { concurrency: false }, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await assert.rejects(async () => resetDbForTesting(), /NODE_ENV=test/);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
      return;
    }
    process.env.NODE_ENV = previousNodeEnv;
  }
});
