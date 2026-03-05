import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { Config } from "../config/Config.js";
import type { MainLoop } from "../core/MainLoop.js";
import type { GlobalMemory } from "../memory/GlobalMemory.js";
import type { TaskStore } from "../memory/TaskStore.js";
import type { CostTracker } from "../utils/cost.js";
import {
  createMockRequest,
  createMockResponse,
  getRequestListener,
} from "./__test-helpers.js";
import type { MockResponseState } from "./__test-helpers.js";
import { CSP_DIRECTIVES, Server } from "./Server.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function createServer(apiToken: string, port = 18801): Server {
  const config = {
    projectPath: process.cwd(),
    values: {
      apiToken,
      server: { host: "127.0.0.1", port },
      evolution: { goals: [] },
    },
  } as unknown as Config;

  const loop = {} as MainLoop;
  const taskStore = {} as TaskStore;
  const globalMemory = {} as GlobalMemory;
  const costTracker = {} as CostTracker;

  return new Server(config, loop, taskStore, globalMemory, costTracker);
}

function authorize(
  server: Server,
  req: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
  },
): boolean {
  const instance = server as unknown as {
    isAuthorizedApiRequest: (request: unknown) => boolean;
  };
  return instance.isAuthorizedApiRequest(req);
}

function assertSecurityHeaders(state: MockResponseState): void {
  assert.equal(state.headers["x-content-type-options"], "nosniff");
  assert.equal(state.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(
    state.headers["content-security-policy"],
    CSP_DIRECTIVES.join("; "),
  );
}

test("auth middleware requires bearer token on /api routes", () => {
  const server = createServer("secret-token");

  assert.equal(
    authorize(server, { method: "GET", url: "/api/status", headers: {} }),
    false,
  );
  assert.equal(
    authorize(server, {
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer wrong" },
    }),
    false,
  );
  assert.equal(
    authorize(server, {
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer secret-token" },
    }),
    true,
  );
  assert.equal(
    authorize(server, {
      method: "GET",
      url: "/api/status",
      headers: { authorization: "bearer secret-token" },
    }),
    true,
  );
});

test("auth middleware exempts non-API and OPTIONS requests", () => {
  const server = createServer("secret-token");

  assert.equal(
    authorize(server, { method: "GET", url: "/", headers: {} }),
    true,
  );
  assert.equal(
    authorize(server, { method: "OPTIONS", url: "/api/status", headers: {} }),
    true,
  );
});

test("security headers are set before static routing", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  const instance = server as unknown as {
    serveStatic: (req: IncomingMessage, res: ServerResponse) => void;
  };
  let staticServed = false;

  instance.serveStatic = (_req, res) => {
    const inspectableResponse = res as ServerResponse & {
      getHeader: (name: string) => string | undefined;
    };
    assert.equal(
      inspectableResponse.getHeader("X-Content-Type-Options"),
      "nosniff",
    );
    assert.equal(
      inspectableResponse.getHeader("X-Frame-Options"),
      "SAMEORIGIN",
    );
    staticServed = true;
    res.writeHead(204);
    res.end();
  };

  await listener(
    createMockRequest({
      method: "GET",
      url: "/",
      headers: { host: "localhost" },
    }),
    response,
  );

  assert.equal(staticServed, true);
  assert.equal(state.statusCode, 204);
  assertSecurityHeaders(state);
});

test("security headers are included on unauthorized API responses", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  let resumed = false;

  await listener(
    createMockRequest({
      method: "GET",
      url: "/api/status",
      headers: { host: "localhost" },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 401);
  assertSecurityHeaders(state);
});

test("rate limiter blocks API requests before auth check", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  const instance = server as unknown as {
    rateLimiter: (ip: string) => boolean;
  };
  let resumed = false;

  instance.rateLimiter = () => false;

  await listener(
    createMockRequest({
      method: "GET",
      url: "/api/status",
      headers: { host: "localhost" },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 429);
  assert.deepEqual(JSON.parse(state.body), { error: "Too Many Requests" });
  assertSecurityHeaders(state);
});

test("rate limiter exempts GET /api/health", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  const instance = server as unknown as {
    rateLimiter: (ip: string) => boolean;
  };
  let resumed = false;

  instance.rateLimiter = () => false;

  await listener(
    createMockRequest({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost" },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(JSON.parse(state.body), { error: "Unauthorized" });
  assertSecurityHeaders(state);
});

test("security headers are included when API request exceeds body limit", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  let resumed = false;

  await listener(
    createMockRequest({
      method: "POST",
      url: "/api/tasks",
      headers: {
        host: "localhost",
        authorization: "Bearer secret-token",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 413);
  assert.equal(state.body, "Payload Too Large");
  assertSecurityHeaders(state);
});

test("security headers are included on API preflight responses", async () => {
  const server = createServer("secret-token");
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();

  await listener(
    createMockRequest({
      method: "OPTIONS",
      url: "/api/status",
      headers: { host: "localhost" },
    }),
    response,
  );

  assert.equal(state.statusCode, 204);
  assertSecurityHeaders(state);
});

// ---- CSP directive content tests ----

test("CSP allows scripts only from self and cdn.jsdelivr.net", () => {
  const policy = CSP_DIRECTIVES.join("; ");
  assert.ok(policy.includes("script-src 'self' https://cdn.jsdelivr.net"));
  // Must NOT permit unsafe-inline or unsafe-eval for scripts
  const scriptDirective = CSP_DIRECTIVES.find((d) =>
    d.startsWith("script-src"),
  );
  assert.ok(scriptDirective, "script-src directive must exist");
  assert.ok(
    !scriptDirective!.includes("unsafe-inline"),
    "script-src must not have unsafe-inline",
  );
  assert.ok(
    !scriptDirective!.includes("unsafe-eval"),
    "script-src must not have unsafe-eval",
  );
});

test("CSP permits inline styles but defaults everything else to self", () => {
  const policy = CSP_DIRECTIVES.join("; ");
  assert.ok(
    policy.includes("default-src 'self'"),
    "default-src should be self",
  );
  assert.ok(
    policy.includes("style-src 'self' 'unsafe-inline'"),
    "style-src should allow unsafe-inline",
  );
  assert.ok(
    policy.includes("img-src 'self' data:"),
    "img-src should allow data: URIs",
  );
  assert.ok(
    policy.includes("connect-src 'self'"),
    "connect-src should be self",
  );
});
