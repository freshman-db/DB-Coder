import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatSession } from '../bridges/ClaudeBridge.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PlanDraft, PlanReviewStatus } from '../memory/types.js';
import type { PlanRequest } from '../prompts/brain.js';
import { PlanWorkflow } from './PlanWorkflow.js';

type SseListener = (event: string, data: string) => void;

type UserChannelMessage = {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
};

type PlanWorkflowInternals = {
  chatSessions: Map<number, ChatSession>;
  sessionLocks: Map<number, Promise<void>>;
  sseListeners: Map<number, Set<SseListener>>;
};

type PlanWorkflowEmitter = {
  emit: (draftId: number, event: string, data: unknown) => void;
};

type PlanWorkflowHandler = {
  handleSDKMessage: (draftId: number, msg: SDKMessage) => Promise<void>;
};

function getInternals(workflow: PlanWorkflow): PlanWorkflowInternals {
  return workflow as unknown as PlanWorkflowInternals;
}

function createMockSession(options: {
  sessionId?: string;
  onPush?: (message: UserChannelMessage) => void;
  onClose?: () => void;
} = {}): ChatSession {
  const sessionId = options.sessionId ?? '';

  return {
    get sessionId() {
      return sessionId;
    },
    query: {} as ChatSession['query'],
    channel: {
      push(message: UserChannelMessage): void {
        options.onPush?.(message);
      },
    } as ChatSession['channel'],
    close(): void {
      options.onClose?.();
    },
  };
}

function createWorkflow(overrides: {
  addChatMessage?: (draftId: number, role: string, content: string, metadata?: unknown) => Promise<unknown>;
  addDailyCost?: (cost: number) => Promise<void>;
  updateChatSessionId?: (draftId: number, sessionId: string) => Promise<void>;
  getPlanDraft?: (draftId: number) => Promise<unknown | null>;
  updateChatStatus?: (draftId: number, status: string) => Promise<void>;
  updatePlanDraftStatus?: (draftId: number, status: PlanReviewStatus) => Promise<void>;
  createChatSession?: () => ChatSession;
} = {}): PlanWorkflow {
  const taskStore = {
    addChatMessage: overrides.addChatMessage ?? (async () => ({})),
    addDailyCost: overrides.addDailyCost ?? (async () => {}),
    updateChatSessionId: overrides.updateChatSessionId ?? (async () => {}),
    getPlanDraft: overrides.getPlanDraft ?? (async () => ({ project_path: '/tmp/project' })),
    updateChatStatus: overrides.updateChatStatus ?? (async () => {}),
    updatePlanDraftStatus: overrides.updatePlanDraftStatus ?? (async () => {}),
  };

  const claude = {
    createChatSession: overrides.createChatSession ?? (() => createMockSession()),
  };

  return new PlanWorkflow(
    {} as ConstructorParameters<typeof PlanWorkflow>[0],
    claude as unknown as ConstructorParameters<typeof PlanWorkflow>[1],
    {} as ConstructorParameters<typeof PlanWorkflow>[2],
    taskStore as unknown as ConstructorParameters<typeof PlanWorkflow>[3],
    {} as ConstructorParameters<typeof PlanWorkflow>[4],
    {} as ConstructorParameters<typeof PlanWorkflow>[5],
    {} as ConstructorParameters<typeof PlanWorkflow>[6],
  );
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createStreamEventMessage(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text,
      },
    },
    parent_tool_use_id: null,
    uuid: 'stream-uuid',
    session_id: 'stream-session',
  } as unknown as SDKMessage;
}

function createResultMessage(data: {
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  messages?: unknown;
} = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: data.result ?? '',
    stop_reason: null,
    total_cost_usd: data.total_cost_usd ?? 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-uuid',
    session_id: data.session_id ?? 'result-session',
    ...(data.messages !== undefined ? { messages: data.messages } : {}),
  } as unknown as SDKMessage;
}

function createPlanDraft(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    id: overrides.id ?? 1,
    project_path: overrides.project_path ?? '/tmp/project',
    plan: overrides.plan ?? {},
    analysis_summary: overrides.analysis_summary ?? '',
    reasoning: overrides.reasoning ?? 'fallback reasoning',
    markdown: overrides.markdown ?? '',
    status: overrides.status ?? 'draft',
    annotations: overrides.annotations ?? [],
    scan_id: overrides.scan_id ?? null,
    cost_usd: overrides.cost_usd ?? 0,
    chat_session_id: overrides.chat_session_id ?? null,
    chat_status: overrides.chat_status ?? null,
    created_at: overrides.created_at ?? new Date('2026-02-22T00:00:00Z'),
    reviewed_at: overrides.reviewed_at ?? null,
  };
}

test('closeSession closes active chat session and clears listener map entry', () => {
  let closeCalled = false;
  const workflow = createWorkflow();
  const internals = getInternals(workflow);

  internals.chatSessions.set(42, createMockSession({ onClose: () => { closeCalled = true; } }));

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  workflow.addSSEListener(42, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  workflow.closeSession(42);

  assert.equal(closeCalled, true);
  assert.equal(internals.chatSessions.has(42), false);
  assert.equal(internals.sseListeners.has(42), false);
  assert.deepEqual(emittedEvents, [{ event: 'status', payload: { status: 'closed' } }]);
});

test('closeSession clears stale SSE listeners even when no chat session exists', () => {
  const workflow = createWorkflow();
  const internals = getInternals(workflow);
  const receivedEvents: string[] = [];

  workflow.addSSEListener(77, event => {
    receivedEvents.push(event);
  });
  assert.equal(internals.sseListeners.has(77), true);

  workflow.closeSession(77);

  assert.equal(internals.sseListeners.has(77), false);
  assert.deepEqual(receivedEvents, ['status']);
});

test('closeSession removes SSE listener map entries and prevents callbacks after cleanup', () => {
  const workflow = createWorkflow();
  const internals = getInternals(workflow);
  const receivedEvents: string[] = [];

  workflow.addSSEListener(88, event => {
    receivedEvents.push(event);
  });

  assert.equal(internals.sseListeners.size, 1);

  workflow.closeSession(88);

  assert.equal(internals.sseListeners.size, 0);
  assert.deepEqual(receivedEvents, ['status']);

  receivedEvents.length = 0;

  (workflow as unknown as PlanWorkflowEmitter).emit(
    88,
    'status',
    { status: 'chatting' },
  );

  assert.deepEqual(receivedEvents, []);
});

test('processUserMessage sends user message through existing chat session', async () => {
  const addChatMessageCalls: Array<[number, string, string]> = [];
  const updateStatusCalls: Array<[number, string]> = [];
  const pushed: UserChannelMessage[] = [];

  const workflow = createWorkflow({
    addChatMessage: async (draftId, role, content) => {
      addChatMessageCalls.push([draftId, role, content]);
      return {};
    },
    getPlanDraft: async () => {
      throw new Error('getPlanDraft should not be called when a chat session already exists');
    },
    updateChatStatus: async (draftId, status) => {
      updateStatusCalls.push([draftId, status]);
    },
  });
  const internals = getInternals(workflow);

  internals.chatSessions.set(5, createMockSession({ sessionId: 'session-5', onPush: msg => pushed.push(msg) }));

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  workflow.addSSEListener(5, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  await workflow.processUserMessage(5, 'Need pagination support');

  assert.deepEqual(addChatMessageCalls, [[5, 'user', 'Need pagination support']]);
  assert.deepEqual(updateStatusCalls, [[5, 'researching']]);
  assert.deepEqual(pushed, [{
    type: 'user',
    message: { role: 'user', content: 'Need pagination support' },
    parent_tool_use_id: null,
    session_id: 'session-5',
  }]);
  assert.deepEqual(emittedEvents, [
    { event: 'message', payload: { role: 'user', content: 'Need pagination support' } },
    { event: 'status', payload: { status: 'researching' } },
  ]);
});

test('processUserMessage keeps listeners when persisting the user message fails before session creation', async () => {
  const workflow = createWorkflow({
    addChatMessage: async () => {
      throw new Error('insert failed');
    },
  });
  const internals = getInternals(workflow);
  const receivedEvents: string[] = [];

  workflow.addSSEListener(9, event => {
    receivedEvents.push(event);
  });
  assert.equal(internals.sseListeners.has(9), true);

  await assert.rejects(
    workflow.processUserMessage(9, 'hello'),
    /insert failed/,
  );

  assert.equal(internals.chatSessions.has(9), false);
  assert.equal(internals.sseListeners.has(9), true);

  (workflow as unknown as PlanWorkflowEmitter).emit(9, 'status', { status: 'chatting' });
  assert.deepEqual(receivedEvents, ['status']);
});

test('processUserMessage keeps listeners when draft lookup fails for a new session', async () => {
  const workflow = createWorkflow({
    getPlanDraft: async () => null,
  });
  const internals = getInternals(workflow);
  const receivedEvents: string[] = [];

  workflow.addSSEListener(11, event => {
    receivedEvents.push(event);
  });
  assert.equal(internals.sseListeners.has(11), true);

  await assert.rejects(
    workflow.processUserMessage(11, 'hello'),
    /Plan draft #11 not found/,
  );

  assert.equal(internals.chatSessions.has(11), false);
  assert.equal(internals.sessionLocks.has(11), false);
  assert.equal(internals.sseListeners.has(11), true);
  assert.deepEqual(receivedEvents, ['message']);

  (workflow as unknown as PlanWorkflowEmitter).emit(11, 'status', { status: 'chatting' });
  assert.deepEqual(receivedEvents, ['message', 'status']);
});

test('processUserMessage creates one chat session when concurrent requests target the same draft', async () => {
  const draftLookup = createDeferred<{ project_path: string }>();
  const createSessionCalls: number[] = [];
  const getPlanDraftCalls: number[] = [];
  const sessionHistoryBySessionId = new Map<string, string[]>();

  const workflow = createWorkflow({
    getPlanDraft: async (draftId) => {
      getPlanDraftCalls.push(draftId);
      return draftLookup.promise;
    },
    createChatSession: () => {
      createSessionCalls.push(1);
      return createMockSession({
        sessionId: 'session-21',
        onPush: (message) => {
          const history = sessionHistoryBySessionId.get(message.session_id) ?? [];
          history.push(message.message.content);
          sessionHistoryBySessionId.set(message.session_id, history);
        },
      });
    },
  });
  const internals = getInternals(workflow);

  const firstRequest = workflow.processUserMessage(21, 'first');
  await Promise.resolve();

  const secondRequest = workflow.processUserMessage(21, 'second');
  await Promise.resolve();

  assert.equal(internals.sessionLocks.has(21), true);
  assert.equal(getPlanDraftCalls.length, 1);
  assert.equal(createSessionCalls.length, 0);

  draftLookup.resolve({ project_path: '/tmp/project' });

  await Promise.all([firstRequest, secondRequest]);

  assert.equal(getPlanDraftCalls.length, 1);
  assert.equal(createSessionCalls.length, 1);
  assert.equal(internals.sessionLocks.has(21), false);
  assert.equal(internals.chatSessions.size, 1);
  assert.equal(internals.chatSessions.has(21), true);
  const activeSession = internals.chatSessions.get(21);
  assert.ok(activeSession);
  assert.deepEqual(sessionHistoryBySessionId.get(activeSession.sessionId), ['first', 'second']);
});

test('handleSDKMessage streams text deltas and emits accumulated assistant text', async () => {
  const workflow = createWorkflow();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];

  workflow.addSSEListener(12, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  const handler = workflow as unknown as PlanWorkflowHandler;
  await handler.handleSDKMessage(12, createStreamEventMessage('Hello'));
  await handler.handleSDKMessage(12, createStreamEventMessage(' world'));

  assert.deepEqual(emittedEvents, [
    { event: 'assistant_text', payload: { text: 'Hello' } },
    { event: 'assistant_text', payload: { text: 'Hello world' } },
  ]);
});

test('handleSDKMessage persists successful result payload and marks ready status', async () => {
  const addChatMessageCalls: Array<[number, string, string, unknown?]> = [];
  const addDailyCostCalls: number[] = [];
  const updateChatStatusCalls: Array<[number, string]> = [];
  const updateChatSessionIdCalls: Array<[number, string]> = [];
  const workflow = createWorkflow({
    addChatMessage: async (draftId, role, content, metadata) => {
      addChatMessageCalls.push([draftId, role, content, metadata]);
      return {};
    },
    addDailyCost: async (cost) => {
      addDailyCostCalls.push(cost);
    },
    updateChatStatus: async (draftId, status) => {
      updateChatStatusCalls.push([draftId, status]);
    },
    updateChatSessionId: async (draftId, sessionId) => {
      updateChatSessionIdCalls.push([draftId, sessionId]);
    },
  });
  const internals = getInternals(workflow);
  internals.chatSessions.set(13, createMockSession({ sessionId: 'session-13' }));

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  workflow.addSSEListener(13, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  const handler = workflow as unknown as PlanWorkflowHandler;
  await handler.handleSDKMessage(13, createResultMessage({
    result: 'Prepared scope [READY_TO_PLAN]',
    total_cost_usd: 1.25,
  }));

  assert.deepEqual(addChatMessageCalls, [[13, 'assistant', 'Prepared scope [READY_TO_PLAN]', { cost: 1.25 }]]);
  assert.deepEqual(addDailyCostCalls, [1.25]);
  assert.deepEqual(updateChatSessionIdCalls, [[13, 'session-13']]);
  assert.deepEqual(updateChatStatusCalls, [[13, 'ready']]);
  assert.deepEqual(emittedEvents, [
    { event: 'message', payload: { role: 'assistant', content: 'Prepared scope [READY_TO_PLAN]' } },
    { event: 'status', payload: { status: 'ready' } },
  ]);
});

test('handleSDKMessage handles missing result fields with safe defaults', async () => {
  const addChatMessageCalls: Array<[number, string, string, unknown?]> = [];
  const addDailyCostCalls: number[] = [];
  const updateChatStatusCalls: Array<[number, string]> = [];
  const updateChatSessionIdCalls: Array<[number, string]> = [];
  const workflow = createWorkflow({
    addChatMessage: async (draftId, role, content, metadata) => {
      addChatMessageCalls.push([draftId, role, content, metadata]);
      return {};
    },
    addDailyCost: async (cost) => {
      addDailyCostCalls.push(cost);
    },
    updateChatStatus: async (draftId, status) => {
      updateChatStatusCalls.push([draftId, status]);
    },
    updateChatSessionId: async (draftId, sessionId) => {
      updateChatSessionIdCalls.push([draftId, sessionId]);
    },
  });

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  workflow.addSSEListener(14, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  const handler = workflow as unknown as PlanWorkflowHandler;
  await handler.handleSDKMessage(14, { type: 'result' } as unknown as SDKMessage);

  assert.deepEqual(addChatMessageCalls, []);
  assert.deepEqual(addDailyCostCalls, [0]);
  assert.deepEqual(updateChatSessionIdCalls, []);
  assert.deepEqual(updateChatStatusCalls, [[14, 'chatting']]);
  assert.deepEqual(emittedEvents, [{ event: 'status', payload: { status: 'chatting' } }]);
});

test('handleSDKMessage extracts assistant text from structured result messages', async () => {
  const addChatMessageCalls: Array<[number, string, string, unknown?]> = [];
  const addDailyCostCalls: number[] = [];
  const updateChatStatusCalls: Array<[number, string]> = [];
  const workflow = createWorkflow({
    addChatMessage: async (draftId, role, content, metadata) => {
      addChatMessageCalls.push([draftId, role, content, metadata]);
      return {};
    },
    addDailyCost: async (cost) => {
      addDailyCostCalls.push(cost);
    },
    updateChatStatus: async (draftId, status) => {
      updateChatStatusCalls.push([draftId, status]);
    },
  });

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  workflow.addSSEListener(15, (event, data) => {
    emittedEvents.push({ event, payload: JSON.parse(data) });
  });

  const handler = workflow as unknown as PlanWorkflowHandler;
  await handler.handleSDKMessage(15, createResultMessage({
    result: '',
    total_cost_usd: 0.75,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Structured output' }, { type: 'tool_use', text: 'ignored' }, { type: 'text', text: ' works' }] },
      { role: 'assistant', content: 'Second line' },
      { role: 'user', content: 'skip me' },
    ],
  }));

  assert.deepEqual(addChatMessageCalls, [[15, 'assistant', 'Structured output works\nSecond line', { cost: 0.75 }]]);
  assert.deepEqual(addDailyCostCalls, [0.75]);
  assert.deepEqual(updateChatStatusCalls, [[15, 'chatting']]);
  assert.deepEqual(emittedEvents, [
    { event: 'message', payload: { role: 'assistant', content: 'Structured output works\nSecond line' } },
    { event: 'status', payload: { status: 'chatting' } },
  ]);
});

test('handleSDKMessage ignores non-array structured messages safely', async () => {
  const addChatMessageCalls: Array<[number, string, string, unknown?]> = [];
  const addDailyCostCalls: number[] = [];
  const updateChatStatusCalls: Array<[number, string]> = [];
  const workflow = createWorkflow({
    addChatMessage: async (draftId, role, content, metadata) => {
      addChatMessageCalls.push([draftId, role, content, metadata]);
      return {};
    },
    addDailyCost: async (cost) => {
      addDailyCostCalls.push(cost);
    },
    updateChatStatus: async (draftId, status) => {
      updateChatStatusCalls.push([draftId, status]);
    },
  });

  const handler = workflow as unknown as PlanWorkflowHandler;
  await handler.handleSDKMessage(16, createResultMessage({
    result: '',
    total_cost_usd: 0.2,
    messages: { role: 'assistant', content: 'not an array' },
  }));

  assert.deepEqual(addChatMessageCalls, []);
  assert.deepEqual(addDailyCostCalls, [0.2]);
  assert.deepEqual(updateChatStatusCalls, [[16, 'chatting']]);
});

test('revisePlan formats annotation feedback and expires the original draft', async () => {
  const updatePlanDraftStatusCalls: Array<[number, PlanReviewStatus]> = [];
  const workflow = createWorkflow({
    getPlanDraft: async () => createPlanDraft({
      id: 21,
      project_path: '/tmp/revise',
      plan: { reasoning: 'plan reasoning' },
      annotations: [
        { task_index: 1, action: 'modify', comment: 'Tighten acceptance criteria', modified_description: 'Use strict typing' },
      ],
    }),
    updatePlanDraftStatus: async (id, status) => {
      updatePlanDraftStatusCalls.push([id, status]);
    },
  });

  const submitCalls: Array<{ projectPath: string; request: PlanRequest }> = [];
  (workflow as unknown as {
    submitRequest: (projectPath: string, request: PlanRequest) => Promise<number>;
  }).submitRequest = async (projectPath, request) => {
    submitCalls.push({ projectPath, request });
    return 77;
  };

  const newDraftId = await workflow.revisePlan(21);

  assert.equal(newDraftId, 77);
  assert.deepEqual(updatePlanDraftStatusCalls, [[21, 'expired']]);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]?.projectPath, '/tmp/revise');
  assert.match(
    submitCalls[0]?.request.description ?? '',
    /Task #1: modify — Tighten acceptance criteria → "Use strict typing"/,
  );
});

test('revisePlan handles null annotations without crashing', async () => {
  const updatePlanDraftStatusCalls: Array<[number, PlanReviewStatus]> = [];
  const workflow = createWorkflow({
    getPlanDraft: async () => createPlanDraft({
      id: 22,
      annotations: null as unknown as PlanDraft['annotations'],
    }),
    updatePlanDraftStatus: async (id, status) => {
      updatePlanDraftStatusCalls.push([id, status]);
    },
  });

  const submitCalls: Array<PlanRequest> = [];
  (workflow as unknown as {
    submitRequest: (projectPath: string, request: PlanRequest) => Promise<number>;
  }).submitRequest = async (_projectPath, request) => {
    submitCalls.push(request);
    return 88;
  };

  const newDraftId = await workflow.revisePlan(22);

  assert.equal(newDraftId, 88);
  assert.deepEqual(updatePlanDraftStatusCalls, [[22, 'expired']]);
  assert.equal(submitCalls.length, 1);
  assert.match(submitCalls[0]?.description ?? '', /Feedback:\n$/);
});
