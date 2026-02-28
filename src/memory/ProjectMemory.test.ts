import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import { log } from '../utils/logger.js';
import { ProjectMemory } from './ProjectMemory.js';

const CLAUDE_MEM_URL = 'http://claude-mem.local';

const originalFetch = globalThis.fetch;
const originalWarn = log.warn;
const originalDebug = log.debug;

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

function disableRetryDelay(memory: ProjectMemory): void {
  (memory as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
}

describe('ProjectMemory', { concurrency: false }, () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    log.warn = originalWarn;
    log.debug = originalDebug;
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
    const fetchMock = installFetchMock(async () => jsonResponse({ error: 'boom' }, 500));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.search('example');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(fetchMock.mock.calls.length, 3);
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0]?.arguments[0]), /HTTP 500/);
  });

  test('search() retries on HTTP 500 and succeeds on second attempt', async () => {
    let attempts = 0;
    const debugMock = mock.fn((_message: string) => {});
    log.debug = debugMock as typeof log.debug;
    const fetchMock = installFetchMock(async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: 'temporary' }, 500);
      }
      return jsonResponse({ content: [{ type: 'text', text: 'recovered' }] }, 200);
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.search('retry me');

    assert.equal(results.ok, true);
    assert.equal(results[0]?.text, 'recovered');
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(debugMock.mock.calls.length, 1);
    assert.match(String(debugMock.mock.calls[0]?.arguments[0]), /retry 1\/2/);
    assert.match(String(debugMock.mock.calls[0]?.arguments[0]), /HTTP 500/);
  });

  test('search() returns empty array when fetch rejects with AbortError', async () => {
    const fetchMock = installFetchMock(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.search('slow request');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(fetchMock.mock.calls.length, 3);
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

  test('search() forwards project/type/format filters and parses index response', async () => {
    const fetchMock = installFetchMock(async () => jsonResponse({
      observations: [
        { id: 11, title: 'obs-1', preview: 'first preview' },
        { id: 12, title: 'obs-2', summary: 'second summary' },
      ],
    }));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const results = await memory.search('example', 2, {
      project: 'repo-alpha',
      type: 'observations',
      format: 'index',
    });

    assert.equal(results.ok, true);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.id, 11);
    assert.equal(results[0]?.title, 'obs-1');
    assert.equal(results[0]?.text, 'first preview');
    assert.equal(results[1]?.id, 12);
    assert.equal(results[1]?.text, 'second summary');

    const [input] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('query'), 'example');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('project'), 'repo-alpha');
    assert.equal(url.searchParams.get('type'), 'observations');
    assert.equal(url.searchParams.get('format'), 'index');
  });

  test('save() sends observation payload to official sessions endpoint', async () => {
    const fetchMock = installFetchMock(async () => jsonResponse({ ok: true }, 201));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const saved = await memory.save(
      'remember this',
      'note',
      'repo-alpha',
      '/workspace/repo-alpha',
      'session-123',
    );

    assert.equal(saved, true);
    assert.equal(fetchMock.mock.calls.length, 1);
    const [input, init] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    assert.equal(String(input), `${CLAUDE_MEM_URL}/api/sessions/observations`);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init.body)), {
      claudeSessionId: 'session-123',
      tool_name: 'db-coder_reflection',
      tool_input: {
        title: 'note',
        project: 'repo-alpha',
        source: 'db-coder',
      },
      tool_response: 'remember this',
      cwd: '/workspace/repo-alpha',
    });
  });

  test('save() falls back to legacy endpoint when sessions endpoint is unavailable', async () => {
    const fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/sessions/observations')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (url.endsWith('/api/memory/save')) {
        return jsonResponse({ ok: true }, 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const saved = await memory.save('remember this', 'note', 'repo-alpha');

    assert.equal(saved, true);
    assert.equal(fetchMock.mock.calls.length, 2);
    const [firstInput] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    const [secondInput] = fetchMock.mock.calls[1]?.arguments as [RequestInfo | URL, RequestInit];
    assert.equal(String(firstInput), `${CLAUDE_MEM_URL}/api/sessions/observations`);
    assert.equal(String(secondInput), `${CLAUDE_MEM_URL}/api/memory/save`);
  });

  test('save() retries on network error and succeeds on second attempt', async () => {
    let attempts = 0;
    const debugMock = mock.fn((_message: string) => {});
    log.debug = debugMock as typeof log.debug;
    const fetchMock = installFetchMock(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse({ ok: true }, 201);
    });
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const saved = await memory.save('remember this');

    assert.equal(saved, true);
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(debugMock.mock.calls.length, 1);
    assert.match(String(debugMock.mock.calls[0]?.arguments[0]), /TypeError/);
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
    const fetchMock = installFetchMock(async () => jsonResponse({ error: 'unavailable' }, 503));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.timeline(7);

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  test('timeline() does not retry on HTTP 400', async () => {
    const debugMock = mock.fn((_message: string) => {});
    log.debug = debugMock as typeof log.debug;
    const fetchMock = installFetchMock(async () => jsonResponse({ error: 'bad request' }, 400));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.timeline(7);

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(debugMock.mock.calls.length, 0);
  });

  test('injectContext() returns injected context text and forwards project filter', async () => {
    const fetchMock = installFetchMock(async () =>
      new Response('<claude-mem-context>\nctx\n</claude-mem-context>', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const memory = new ProjectMemory(CLAUDE_MEM_URL);

    const context = await memory.injectContext('repo-alpha');

    assert.equal(context, '<claude-mem-context>\nctx\n</claude-mem-context>');
    const [input] = fetchMock.mock.calls[0]?.arguments as [RequestInfo | URL, RequestInit];
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/context/inject');
    assert.equal(url.searchParams.get('project'), 'repo-alpha');
  });

  test('injectContext() returns null on non-2xx response', async () => {
    installFetchMock(async () => jsonResponse({ error: 'offline' }, 503));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const context = await memory.injectContext('repo-alpha');

    assert.equal(context, null);
  });

  test('search() gives up after max retries', async () => {
    const debugMock = mock.fn((_message: string) => {});
    log.debug = debugMock as typeof log.debug;
    const fetchMock = installFetchMock(async () => jsonResponse({ error: 'still down' }, 503));
    const memory = new ProjectMemory(CLAUDE_MEM_URL);
    disableRetryDelay(memory);

    const results = await memory.search('still failing');

    assert.equal(results.ok, false);
    assert.equal(results.length, 0);
    assert.equal(fetchMock.mock.calls.length, 3);
    assert.equal(debugMock.mock.calls.length, 2);
    assert.match(String(debugMock.mock.calls[0]?.arguments[0]), /retry 1\/2/);
    assert.match(String(debugMock.mock.calls[1]?.arguments[0]), /retry 2\/2/);
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
