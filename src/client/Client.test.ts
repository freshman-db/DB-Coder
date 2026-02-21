import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from './Client.js';

test('Client adds bearer token to GET, POST, and DELETE requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new Client(18800, '127.0.0.1', 'secret-token');
    await client.status();
    await client.addTask('Ship auth support');
    await client.deleteTask('task-1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
  for (const init of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer secret-token');
  }
});

test('Client adds bearer token to log stream requests', async () => {
  const originalFetch = globalThis.fetch;
  let receivedAuthHeader: string | null = null;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    receivedAuthHeader = new Headers(init?.headers).get('authorization');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"message":"hello"}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
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
