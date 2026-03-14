import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChatMessageMetadata,
  ReviewAnnotationsJson,
  TaskPlanJson,
} from '../../src/memory/schemas.js';

test('defines typed JSON payloads for task plan columns', () => {
  const taskPlan: TaskPlanJson = {
    tasks: [{
      id: 'T1',
      description: 'Implement typed schema module',
      priority: 1,
      executor: 'codex',
      subtasks: [{ id: 'S1', description: 'Add schema interfaces', executor: 'codex' }],
      dependsOn: [],
      estimatedComplexity: 'low',
      type: 'refactor',
    }],
    reasoning: 'Introduce explicit JSONB contracts before replacing casts.',
  };

  assert.equal(taskPlan.tasks[0].subtasks.length, 1);
});

test('defines typed payloads for annotations and chat metadata columns', () => {
  const annotations: ReviewAnnotationsJson = [
    { task_index: 0, action: 'approve', comment: 'Looks solid.' },
    {
      task_index: 1,
      action: 'modify',
      comment: 'Clarify rollback behavior.',
      modified_description: 'Document rollback strategy in the final task.',
    },
  ];

  const metadata: ChatMessageMetadata = {
    cost: 1.25,
    requestId: 'req-42',
    channel: 'plan-chat',
    tokenUsage: 1250,
  };

  assert.equal(annotations[1].action, 'modify');
  assert.equal(metadata.channel, 'plan-chat');
});
