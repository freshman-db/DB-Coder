import assert from 'node:assert/strict';
import test from 'node:test';

import { extractJsonFromText, tryParseReview } from './parse.js';

test('extractJsonFromText returns the first valid balanced JSON object', () => {
  const input = 'note {not-json} and {"status":"ok","meta":{"count":2}} tail';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: 'ok',
    meta: { count: 2 },
  });
});

test('extractJsonFromText handles braces inside JSON strings', () => {
  const input = 'prefix {"message":"hello {world}","items":[1,2,3]} suffix';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    message: 'hello {world}',
    items: [1, 2, 3],
  });
});

test('extractJsonFromText returns null for empty or non-string input', () => {
  assert.equal(extractJsonFromText(''), null);
  assert.equal(extractJsonFromText(undefined as unknown as string), null);
});

test('extractJsonFromText can match a later JSON object', () => {
  const input = [
    'metadata: {"requestId":"123"}',
    'payload:',
    '{"projectHealth":87,"issues":[],"opportunities":[],"summary":"ok"}',
  ].join('\n');
  const parsed = extractJsonFromText(
    input,
    (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'projectHealth' in value),
  ) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    projectHealth: 87,
    issues: [],
    opportunities: [],
    summary: 'ok',
  });
});

test('tryParseReview finds the review JSON object even when earlier JSON exists', () => {
  const input = [
    'Metadata: {"requestId":"abc-123"}',
    'Review follows:',
    '{"passed":false,"issues":[{"severity":"high","description":"Issue"}],"summary":"Needs follow-up"}',
  ].join('\n');

  const parsed = tryParseReview(input);

  assert.equal(parsed.passed, false);
  assert.equal(parsed.summary, 'Needs follow-up');
  assert.equal(parsed.issues.length, 1);
});

test('tryParseReview falls back to text heuristics when JSON is unavailable', () => {
  const parsed = tryParseReview('Critical bug found in login flow.');

  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.summary, 'Critical bug found in login flow.');
});

test('tryParseReview handles empty or non-string input safely', () => {
  assert.deepEqual(tryParseReview(''), {
    passed: true,
    issues: [],
    summary: '',
  });

  assert.deepEqual(tryParseReview(undefined as unknown as string), {
    passed: true,
    issues: [],
    summary: '',
  });
});
