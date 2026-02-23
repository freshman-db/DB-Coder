import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import { log } from '../utils/logger.js';
import { ProjectMemory } from './ProjectMemory.js';

const CLAUDE_MEM_URL = 'http://claude-mem.local';

const originalFetch = globalThis.fetch;
const originalWarn = log.warn;

function installFetchMock(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = mock.fn(implementation);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ProjectMemory', { concurrency: false }, () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    log.warn = originalWarn;
    mock.restoreAll();
  });

  test('search() returns extracted text on success', async () => {
    const fetchMock = installFetchMock(async () => jsonResponse({
      results: [{ text: 'x' }],
      content: [{ type: 'text', text: 'x' }],
    }));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.search('example');

    assert.equal(results.ok, true);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.text, 'x');
    assert.equal(fetchMock.mock.calls.length, 1);
    const requestInit = fetchMock.mock.calls[0]?.arguments[1] as RequestInit | undefined;
    assert.ok(requestInit?.signal instanceof AbortSignal);
  });

  test('search() returns empty array and logs warning on HTTP 500', async () => {
    const warnMock = mock.fn((_message: string) => {});
    log.warn = warnMock as typeof log.warn;
    installFetchMock(async () => jsonResponse({ error: 'boom' }, 500));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.search('example');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0]?.arguments[0]), /HTTP 500/);
  });

  test('search() returns empty array when fetch rejects with AbortError', async () => {
    installFetchMock(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.search('slow request');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
  });

  test('search() returns empty array when response JSON is malformed', async () => {
    installFetchMock(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }) as unknown as Response);
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.search('bad json');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
  });

  test('save() sends POST request with expected JSON body', async () => {
    const fetchMock = installFetchMock(async () => jsonResponse({ ok: true }, 201));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const saved = await memory.save('remember this', 'note', 'repo-alpha');

    assert.equal(saved, true);
    assert.equal(fetchMock.mock.calls.length, 1);
    const [input, init] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    assert.equal(String(input), `${CLAUDE_MEM_URL}/api/memory/save`);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init.body)), {
      text: 'remember this',
      title: 'note',
      project: 'repo-alpha',
    });
  });

  test('save() logs warning and returns false when fetch rejects', async () => {
    const warnMock = mock.fn((_message: string) => {});
    log.warn = warnMock as typeof log.warn;
    installFetchMock(async () => {
      throw new Error('connection reset');
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const saved = await memory.save('remember this');

    assert.equal(saved, false);
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0]?.arguments[0]), /failed to save/);
  });

  test('timeline() includes anchor in query params and returns text', async () => {
    const fetchMock = installFetchMock(async () => jsonResponse({
      content: [{ type: 'text', text: 'timeline entry' }],
    }));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.timeline(42, 2, 4);

    assert.equal(results.ok, true);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 42);
    assert.equal(results[0]?.text, 'timeline entry');
    const [input] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/timeline');
    assert.equal(url.searchParams.get('anchor'), '42');
    assert.equal(url.searchParams.get('depth_before'), '2');
    assert.equal(url.searchParams.get('depth_after'), '4');
  });

  test('timeline() returns empty array on failure', async () => {
    installFetchMock(async () => jsonResponse({ error: 'unavailable' }, 503));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.timeline(7);

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
  });

  test('extractText() returns empty string for an empty content array', () => {
    const memory = new ProjectMemory(CLAUDE_MEM_URL) as unknown as {
      extractText: (data: { content?: Array<{ type: string; text: string }> | null }) => string;
    };

    assert.equal(memory.extractText({ content: [] }), '');
  });

  test('extractText() returns empty string for null content', () => {
    const memory = new ProjectMemory(CLAUDE_MEM_URL) as unknown as {
      extractText: (data: { content?: Array<{ type: string; text: string }> | null }) => string;
    };

    assert.equal(memory.extractText({ content: null }), '');
  });
});
