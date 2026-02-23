import assert from 'node:assert/strict';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

import type { Server } from './Server.js';

export interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface MockRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string | string[]>;
  token?: string;
  authorization?: string;
  body?: unknown;
  resume?: () => void;
}

type MockResponse = ServerResponse & {
  getHeader: (name: string) => string | undefined;
};

function normalizeHeaderName(name: string): string {
  return name.toLowerCase();
}

function headerValueToString(value: string | number | readonly string[]): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

export function createMockResponse(): {
  response: MockResponse;
  state: MockResponseState;
} {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  const response = {
    setHeader: (name: string, value: string | number | readonly string[]): void => {
      state.headers[normalizeHeaderName(name)] = headerValueToString(value);
    },
    getHeader: (name: string): string | undefined => state.headers[normalizeHeaderName(name)],
    write: (chunk?: string | Buffer): boolean => {
      if (chunk === undefined) {
        return true;
      }
      state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      return true;
    },
    writeHead: (statusCode: number, headers?: Record<string, string | number | readonly string[]>): ServerResponse => {
      state.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          state.headers[normalizeHeaderName(name)] = headerValueToString(value);
        }
      }
      return response as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer): void => {
      if (chunk === undefined) {
        return;
      }
      state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    },
  } as unknown as MockResponse;

  return { response, state };
}

export function createMockRequest(options: MockRequestOptions): IncomingMessage {
  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
  };

  req.method = options.method;
  req.url = options.url;

  const headers: Record<string, string | string[]> = options.headers === undefined
    ? { host: 'localhost' }
    : { ...options.headers };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  } else if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }

  let bodyText: string | undefined;
  if (options.body !== undefined) {
    bodyText = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(bodyText));
  }

  req.headers = headers;

  if (options.resume) {
    const originalResume = req.resume.bind(req);
    req.resume = (() => {
      options.resume?.();
      return originalResume();
    }) as typeof req.resume;
  }

  if (bodyText === undefined) {
    req.end();
  } else {
    req.end(bodyText);
  }

  return req as unknown as IncomingMessage;
}

export function getRequestListener(server: Server): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const instance = server as unknown as { server: HttpServer };
  const [listener] = instance.server.listeners('request');
  assert.equal(typeof listener, 'function');
  return async (req, res) => {
    await listener(req, res);
  };
}
