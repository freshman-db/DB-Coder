import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAnalysis, parseEvaluation, parsePlan, parseReflection } from './Brain.js';

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

test('parseEvaluation returns passed=true with correct total for valid positive scores', () => {
  const output = JSON.stringify({
    problemLegitimacy: 2,
    solutionProportionality: 1,
    expectedComplexity: 1,
    historicalSuccess: 2,
    reasoning: 'Valuable and scoped correctly.',
  });

  const parsed = parseEvaluation(output);

  assert.equal(parsed.passed, true);
  assert.equal(parsed.score.problemLegitimacy, 2);
  assert.equal(parsed.score.solutionProportionality, 1);
  assert.equal(parsed.score.expectedComplexity, 1);
  assert.equal(parsed.score.historicalSuccess, 2);
  assert.equal(parsed.score.total, 6);
  assert.equal(parsed.reasoning, 'Valuable and scoped correctly.');
});

test('parseEvaluation treats total=0 as failed boundary', () => {
  const output = JSON.stringify({
    problemLegitimacy: 2,
    solutionProportionality: -1,
    expectedComplexity: -1,
    historicalSuccess: 0,
    reasoning: 'Mixed signals.',
  });

  const parsed = parseEvaluation(output);

  assert.equal(parsed.score.total, 0);
  assert.equal(parsed.passed, false);
});

test('parseEvaluation clamps out-of-range scores to [-2, 2]', () => {
  const output = JSON.stringify({
    problemLegitimacy: 9,
    solutionProportionality: -8,
    expectedComplexity: 2.5,
    historicalSuccess: -3.5,
  });

  const parsed = parseEvaluation(output);

  assert.equal(parsed.score.problemLegitimacy, 2);
  assert.equal(parsed.score.solutionProportionality, -2);
  assert.equal(parsed.score.expectedComplexity, 2);
  assert.equal(parsed.score.historicalSuccess, -2);
  assert.equal(parsed.score.total, 0);
});

test('parseEvaluation defaults reasoning to empty string when missing', () => {
  const output = JSON.stringify({
    problemLegitimacy: 1,
    solutionProportionality: 1,
    expectedComplexity: 0,
    historicalSuccess: 0,
  });

  const parsed = parseEvaluation(output);

  assert.equal(parsed.reasoning, '');
});

test('parseEvaluation returns failed defaults for invalid JSON', () => {
  const parsed = parseEvaluation('not json');

  assert.equal(parsed.passed, false);
  assert.equal(parsed.score.total, 0);
  assert.equal(parsed.score.problemLegitimacy, 0);
  assert.equal(parsed.score.solutionProportionality, 0);
  assert.equal(parsed.score.expectedComplexity, 0);
  assert.equal(parsed.score.historicalSuccess, 0);
  assert.equal(parsed.reasoning, 'not json');
});

test('parseEvaluation uses "Empty evaluation output" for empty input', () => {
  const parsed = parseEvaluation('');

  assert.equal(parsed.passed, false);
  assert.equal(parsed.reasoning, 'Empty evaluation output');
});

test('parseEvaluation treats missing score fields as zero', () => {
  const output = JSON.stringify({
    problemLegitimacy: 2,
    reasoning: 'Only one dimension provided.',
  });

  const parsed = parseEvaluation(output);

  assert.equal(parsed.score.problemLegitimacy, 2);
  assert.equal(parsed.score.solutionProportionality, 0);
  assert.equal(parsed.score.expectedComplexity, 0);
  assert.equal(parsed.score.historicalSuccess, 0);
  assert.equal(parsed.score.total, 2);
  assert.equal(parsed.passed, true);
});
