import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BaselineMetricsJson,
  ChatMessageMetadata,
  ConfigProposalValue,
  PatchSetJson,
  ReviewAnnotationsJson,
  ScanResultJson,
  TaskPlanJson,
} from './schemas.js';

test('defines typed JSON payloads for scan and task plan columns', () => {
  const scanResult: ScanResultJson = {
    issues: [{
      type: 'quality',
      severity: 'high',
      description: 'Unused imports in core workflow',
      file: 'src/core/MainLoop.ts',
      line: 19,
      suggestion: 'Remove dead imports and rerun build',
    }],
    opportunities: [{
      type: 'refactor',
      severity: 'low',
      description: 'Extract retry logic into helper',
    }],
    projectHealth: 76,
    summary: 'Core workflows are stable but need cleanup',
    codeMetrics: {
      typeErrors: 0,
      longFunctions: [{ file: 'src/core/MainLoop.ts', name: 'run', lines: 148 }],
      duplicatePatterns: [{ files: ['src/core/MainLoop.ts', 'src/core/PlanWorkflow.ts'], description: 'Repeated status updates' }],
      deadCode: [{ file: 'src/core/Brain.ts', description: 'Unused parser fallback' }],
    },
    simplificationTargets: [{
      file: 'src/core/PlanWorkflow.ts',
      description: 'Session startup does too much in one method',
      complexity: 'high',
      suggestion: 'Split setup into smaller private methods',
    }],
    featureGaps: [{
      area: 'integration-tests',
      description: 'No coverage for plan chat resume flow',
      suggestion: 'Add persistence + resume integration test',
    }],
  };

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

  assert.equal(scanResult.projectHealth, 76);
  assert.equal(taskPlan.tasks[0].subtasks.length, 1);
});

test('defines typed payloads for prompt patch, metrics, annotations, and chat metadata columns', () => {
  const patchSet: PatchSetJson = [{
    op: 'append',
    section: '## Guardrails',
    content: 'Always validate parsed JSON before executing side effects.',
    reason: 'Reduce malformed output retries',
  }];

  const baselineMetrics: BaselineMetricsJson = {
    passRate: 0.92,
    avgCostUsd: 1.18,
    issueCount: 2,
    tasksEvaluated: 24,
  };

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

  assert.equal(patchSet[0].op, 'append');
  assert.equal(baselineMetrics.tasksEvaluated, 24);
  assert.equal(annotations[1].action, 'modify');
  assert.equal(metadata.channel, 'plan-chat');
});

test('allows nested and boundary JSON values for config proposal columns', () => {
  const nestedObject: ConfigProposalValue = {
    evolution: {
      autoConfigUpdate: true,
      trendWindowSize: 10,
      goals: [{ description: 'Improve reliability', priority: 0, status: 'active' }],
      metadata: {
        owner: 'agent',
        notes: null,
      },
    },
  };

  const primitiveBoundary: ConfigProposalValue = 0;
  const arrayBoundary: ConfigProposalValue = [true, false, 'codex', { retries: 3 }];

  assert.equal(typeof primitiveBoundary, 'number');
  assert.ok(Array.isArray(arrayBoundary));
  assert.ok(typeof nestedObject === 'object' && nestedObject !== null && !Array.isArray(nestedObject));
});
