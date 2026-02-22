import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { Memory } from './types.js';
import { GlobalMemory } from './GlobalMemory.js';

interface TaggedCall {
  text: string;
  values: unknown[];
}

interface UnsafeCall {
  text: string;
  values: unknown[];
}

type SqlMock = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  unsafe: (query: string, values?: unknown[]) => Promise<{ count: number }>;
  json: (value: unknown) => { __json: unknown };
};

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildParameterizedText(strings: readonly string[], valueCount: number): string {
  let text = '';
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index];
    if (index < valueCount) {
      text += `$${index + 1}`;
    }
  }
  return normalizeSql(text);
}

function createSqlMock(): {
  sql: SqlMock;
  taggedCalls: TaggedCall[];
  unsafeCalls: UnsafeCall[];
  jsonCalls: unknown[];
  enqueueResult: (rows: unknown[]) => void;
} {
  const taggedCalls: TaggedCall[] = [];
  const unsafeCalls: UnsafeCall[] = [];
  const jsonCalls: unknown[] = [];
  const queuedRows: unknown[][] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    taggedCalls.push({
      text: buildParameterizedText(strings, values.length),
      values: [...values],
    });
    return queuedRows.shift() ?? [];
  }) as unknown as SqlMock;

  sql.unsafe = async (query: string, values: unknown[] = []) => {
    unsafeCalls.push({ text: normalizeSql(query), values: [...values] });
    return { count: 0 };
  };

  sql.json = (value: unknown) => {
    jsonCalls.push(value);
    return { __json: value };
  };

  return {
    sql,
    taggedCalls,
    unsafeCalls,
    jsonCalls,
    enqueueResult: (rows: unknown[]) => queuedRows.push(rows),
  };
}

function createGlobalMemory(sql: SqlMock): GlobalMemory {
  const store = Object.create(GlobalMemory.prototype) as GlobalMemory;
  (store as unknown as { sql: SqlMock }).sql = sql;
  (store as unknown as { isClosed: boolean }).isClosed = false;
  return store;
}

function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1,
    category: 'workflow',
    title: 'Default title',
    content: 'Default content',
    tags: ['memory'],
    source_project: '/repo/default',
    confidence: 0.5,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    updated_at: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GlobalMemory.add', () => {
  test('stores tags via sql.json and returns inserted memory row', async () => {
    const { sql, taggedCalls, jsonCalls, enqueueResult } = createSqlMock();
    const store = createGlobalMemory(sql);

    const payload = {
      category: 'workflow' as const,
      title: 'Postgres migration runbook',
      content: 'Run migrations before rolling restart.',
      tags: ['postgres', 'migrations'],
      source_project: '/repo/api',
      confidence: 0.9,
    };
    const inserted = createMemory({
      id: 17,
      category: payload.category,
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      source_project: payload.source_project,
      confidence: payload.confidence,
    });
    enqueueResult([inserted]);

    const row = await store.add(payload);

    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0], payload.tags);
    assert.equal(
      taggedCalls[0].text,
      'INSERT INTO memories (category, title, content, tags, source_project, confidence) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    );
    assert.deepEqual(taggedCalls[0].values, [
      payload.category,
      payload.title,
      payload.content,
      { __json: payload.tags },
      payload.source_project,
      payload.confidence,
    ]);
    assert.equal(row, inserted);
  });
});

describe('GlobalMemory.search', () => {
  test('uses pg_trgm similarity operators alongside full-text ranking', async () => {
    const { sql, taggedCalls, enqueueResult } = createSqlMock();
    const store = createGlobalMemory(sql);
    const expectedRows = [createMemory({ id: 23, title: 'Improve pg_trgm ranking' })];
    enqueueResult(expectedRows);

    const rows = await store.search('pg_trgm ranking', 7);

    assert.equal(
      taggedCalls[0].text,
      "SELECT *, ts_rank(to_tsvector('simple', title || ' ' || content), plainto_tsquery('simple', $1)) * confidence AS relevance FROM memories WHERE to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', $2) OR title % $3 OR content % $4 ORDER BY relevance DESC LIMIT $5",
    );
    assert.deepEqual(taggedCalls[0].values, [
      'pg_trgm ranking',
      'pg_trgm ranking',
      'pg_trgm ranking',
      'pg_trgm ranking',
      7,
    ]);
    assert.deepEqual(rows, expectedRows);
  });
});

describe('GlobalMemory.updateConfidence', () => {
  test('increments confidence with clamped LEAST/GREATEST update', async () => {
    const { sql, taggedCalls } = createSqlMock();
    const store = createGlobalMemory(sql);

    await store.updateConfidence(11, 0.2);

    assert.equal(
      taggedCalls[0].text,
      'UPDATE memories SET confidence = LEAST(1.0, GREATEST(0.0, confidence + $1)), updated_at = NOW() WHERE id = $2',
    );
    assert.deepEqual(taggedCalls[0].values, [0.2, 11]);
  });
});

describe('GlobalMemory.getByCategory', () => {
  test('filters by category and applies default limit ordering', async () => {
    const { sql, taggedCalls } = createSqlMock();
    const store = createGlobalMemory(sql);

    await store.getByCategory('standard');

    assert.equal(
      taggedCalls[0].text,
      'SELECT * FROM memories WHERE category = $1 ORDER BY confidence DESC, updated_at DESC LIMIT $2',
    );
    assert.deepEqual(taggedCalls[0].values, ['standard', 20]);
  });
});

describe('GlobalMemory.getRelevant', () => {
  test('passes project/category scoped query to search and formats matching memories', async () => {
    const { sql } = createSqlMock();
    const store = createGlobalMemory(sql);
    const filteredRows = [
      createMemory({
        id: 31,
        category: 'workflow',
        title: 'CI migration checks',
        content: 'Validate migration order before deploy.',
        source_project: '/repo/alpha',
      }),
    ];
    const searchCalls: Array<{ query: string; limit: number }> = [];

    (store as unknown as {
      search: (query: string, limit?: number) => Promise<Memory[]>;
    }).search = async (query: string, limit = 10) => {
      searchCalls.push({ query, limit });
      return filteredRows;
    };

    const context = await store.getRelevant('project:alpha category:workflow migration');

    assert.deepEqual(searchCalls, [{ query: 'project:alpha category:workflow migration', limit: 10 }]);
    assert.equal(context, '[workflow] CI migration checks: Validate migration order before deploy.\n');
  });
});

describe('GlobalMemory close semantics', () => {
  test('close marks store as closed and clears sql handle', async () => {
    const { sql } = createSqlMock();
    const store = createGlobalMemory(sql);

    await store.close();

    assert.equal((store as unknown as { isClosed: boolean }).isClosed, true);
    assert.equal((store as unknown as { sql: unknown }).sql, null);
  });

  test('getSql throws once close has been called', async () => {
    const { sql } = createSqlMock();
    const store = createGlobalMemory(sql);

    await store.close();

    assert.throws(
      () => (store as unknown as { getSql: () => unknown }).getSql(),
      /GlobalMemory is closed/,
    );
    await assert.rejects(() => store.search('still-open?'), /GlobalMemory is closed/);
  });
});
