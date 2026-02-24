import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from './Client.js';

/** Helper: mock fetch, run callback, return captured RequestInit list */
async function withMockFetch(fn: (client: Client) => Promise<void>): Promise<{ url: string; init: RequestInit }[]> {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }) as typeof fetch;

  try {
    await fn(new Client(18800, '127.0.0.1', 'secret-token'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
}

test('Client adds bearer token to GET, POST, and DELETE requests', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.status();
    await client.addTask('Ship auth support');
    await client.deleteTask('task-1');
  });

  assert.equal(calls.length, 3);
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer secret-token');
  }
});

test('Client adds bearer token to log stream requests', async () => {
  const originalFetch = globalThis.fetch;
  let receivedAuthHeader: string | null = null;

  globalThis.fetch = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    receivedAuthHeader = new Headers(init?.headers).get('authorization');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"message":"hello"}\n\n'));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as typeof fetch;

  const entries: unknown[] = [];
  try {
    const client = new Client(18800, '127.0.0.1', 'secret-token');
    await client.followLogs((entry) => entries.push(entry));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(receivedAuthHeader, 'Bearer secret-token');
  assert.deepEqual(entries, [{ message: 'hello' }]);
});

// --- New patrol/approve/skip method tests ---

test('patrolStart sends POST to /api/patrol/start with auth', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.patrolStart();
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/patrol/start'));
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer secret-token');
});

test('patrolStop sends POST to /api/patrol/stop with auth', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.patrolStop();
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/patrol/stop'));
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer secret-token');
});

test('approveTask sends POST to /api/tasks/:id/approve', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.approveTask('abc-123');
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/tasks/abc-123/approve'));
  assert.equal(calls[0].init.method, 'POST');
});

test('skipTask sends POST to /api/tasks/:id/skip', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.skipTask('abc-123');
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/tasks/abc-123/skip'));
  assert.equal(calls[0].init.method, 'POST');
});

test('metrics sends GET to /api/metrics', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.metrics();
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/metrics'));
  assert.equal(calls[0].init.method, undefined); // GET has no explicit method
});

test('pendingReviewTasks sends GET to /api/tasks/pending-review', async () => {
  const calls = await withMockFetch(async (client) => {
    await client.pendingReviewTasks();
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/tasks/pending-review'));
});

// --- Compile-time check: stale memory methods are gone ---

test('stale memory methods do not exist on Client', () => {
  const client = new Client();
  assert.equal('searchMemory' in client, false, 'searchMemory should be removed');
  assert.equal('addMemory' in client, false, 'addMemory should be removed');
});

// --- followLogs abort signal cancellation ---

test('followLogs passes AbortSignal to fetch and aborts cleanly', async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal: AbortSignal | undefined;

  globalThis.fetch = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    receivedSignal = init?.signal ?? undefined;
    // Return a stream that never closes — the abort signal should cancel it
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // deliberately left open
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as typeof fetch;

  try {
    const controller = new AbortController();
    const client = new Client(18800, '127.0.0.1', 'secret-token');
    const promise = client.followLogs(() => {}, controller.signal);

    // Give it a tick to start reading, then abort
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    await assert.rejects(promise, (err: Error) => {
      return err.name === 'AbortError';
    });
    assert.ok(receivedSignal, 'AbortSignal should be passed to fetch');
    assert.equal(receivedSignal!.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
