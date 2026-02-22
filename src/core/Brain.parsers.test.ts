import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAnalysis, parsePlan, parseReflection } from './Brain.js';

test('parseAnalysis ignores unrelated JSON and parses the matching payload', () => {
  const output = [
    'metadata: {"requestId":"abc-123"}',
    'analysis:',
    '{"projectHealth":91,"issues":[{"severity":"high","description":"a"}],"opportunities":[],"summary":"Healthy overall"}',
    'tail',
  ].join('\n');

  const parsed = parseAnalysis(output);

  assert.equal(parsed.projectHealth, 91);
  assert.equal(parsed.summary, 'Healthy overall');
  assert.equal(parsed.issues.length, 1);
});

test('parsePlan parses balanced JSON even when braces appear in surrounding text', () => {
  const output = [
    'Ignore this {not json} line.',
    '{"tasks":[{"id":"t1","description":"Fix parser","priority":1,"executor":"codex","subtasks":[],"dependsOn":[],"estimatedComplexity":"low"}],"reasoning":"Use shared parser"}',
    'more notes {with braces}',
  ].join('\n');

  const parsed = parsePlan(output);

  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, 't1');
  assert.equal(parsed.reasoning, 'Use shared parser');
});

test('parseReflection falls back safely when no reflection JSON exists', () => {
  const output = 'No JSON here, only a text summary.';

  const parsed = parseReflection(output);

  assert.deepEqual(parsed.experiences, []);
  assert.deepEqual(parsed.adjustments, []);
  assert.equal(parsed.taskSummary, output);
});
