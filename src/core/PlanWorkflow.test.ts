import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatSession } from '../bridges/ClaudeBridge.js';
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
  sseListeners: Map<number, Set<SseListener>>;
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
  addChatMessage?: (draftId: number, role: string, content: string) => Promise<unknown>;
  getPlanDraft?: (draftId: number) => Promise<{ project_path: string } | null>;
  updateChatStatus?: (draftId: number, status: string) => Promise<void>;
  createChatSession?: () => ChatSession;
} = {}): PlanWorkflow {
  const taskStore = {
    addChatMessage: overrides.addChatMessage ?? (async () => ({})),
    getPlanDraft: overrides.getPlanDraft ?? (async () => ({ project_path: '/tmp/project' })),
    updateChatStatus: overrides.updateChatStatus ?? (async () => {}),
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

test('closeSession closes active chat session and clears listener map entry', () => {
  let closeCalled = false;
  const workflow = createWorkflow();
  const internals = getInternals(workflow);

  internals.chatSessions.set(42, createMockSession({ onClose: () => { closeCalled = true; } }));

  let eventCount = 0;
  workflow.addSSEListener(42, () => {
    eventCount += 1;
  });

  workflow.closeSession(42);

  assert.equal(closeCalled, true);
  assert.equal(internals.chatSessions.has(42), false);
  assert.equal(internals.sseListeners.has(42), false);
  assert.equal(eventCount, 0);
});

test('closeSession clears stale SSE listeners even when no chat session exists', () => {
  const workflow = createWorkflow();
  const internals = getInternals(workflow);

  workflow.addSSEListener(77, () => {});
  assert.equal(internals.sseListeners.has(77), true);

  workflow.closeSession(77);

  assert.equal(internals.sseListeners.has(77), false);
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

test('processUserMessage clears listeners when persisting the user message fails before session creation', async () => {
  const workflow = createWorkflow({
    addChatMessage: async () => {
      throw new Error('insert failed');
    },
  });
  const internals = getInternals(workflow);

  workflow.addSSEListener(9, () => {});
  assert.equal(internals.sseListeners.has(9), true);

  await assert.rejects(
    workflow.processUserMessage(9, 'hello'),
    /insert failed/,
  );

  assert.equal(internals.chatSessions.has(9), false);
  assert.equal(internals.sseListeners.has(9), false);
});

test('processUserMessage clears listeners when draft lookup fails for a new session', async () => {
  const workflow = createWorkflow({
    getPlanDraft: async () => null,
  });
  const internals = getInternals(workflow);

  workflow.addSSEListener(11, () => {});
  assert.equal(internals.sseListeners.has(11), true);

  await assert.rejects(
    workflow.processUserMessage(11, 'hello'),
    /Plan draft #11 not found/,
  );

  assert.equal(internals.chatSessions.has(11), false);
  assert.equal(internals.sseListeners.has(11), false);
});
