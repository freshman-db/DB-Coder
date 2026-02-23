import assert from 'node:assert/strict';
import test from 'node:test';

import { extractJsonFromText, getErrorMessage, isPositiveFinite, isRecord, truncate, tryParseJson, tryParseReview } from './parse.js';

test('truncate returns short strings unchanged', () => {
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate returns exact-length strings unchanged', () => {
  assert.equal(truncate('12345', 5), '12345');
});

test('truncate shortens over-length strings and appends an ellipsis', () => {
  assert.equal(truncate('123456', 5), '12345…');
});

test('truncate returns empty strings unchanged', () => {
  assert.equal(truncate('', 5), '');
});

test('isRecord identifies plain objects and rejects non-objects', () => {
  assert.equal(isRecord({ key: 'value' }), true);
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord('text'), false);
});

test('isPositiveFinite validates only positive finite numbers', () => {
  assert.equal(isPositiveFinite(5), true);
  assert.equal(isPositiveFinite(0), false);
  assert.equal(isPositiveFinite(-1), false);
  assert.equal(isPositiveFinite(Infinity), false);
  assert.equal(isPositiveFinite(Number.NaN), false);
  assert.equal(isPositiveFinite('5'), false);
  assert.equal(isPositiveFinite(null), false);
});

test('getErrorMessage normalizes unknown errors to strings', () => {
  assert.equal(getErrorMessage(new Error('boom')), 'boom');
  assert.equal(getErrorMessage('plain message'), 'plain message');
  assert.equal(getErrorMessage(42), '42');
  assert.equal(getErrorMessage(null), 'null');
  assert.equal(getErrorMessage(undefined), 'undefined');
  assert.equal(getErrorMessage({}), '[object Object]');
});

test('extractJsonFromText parses clean JSON', () => {
  const input = '{"status":"ok","count":2}';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: 'ok',
    count: 2,
  });
});

test('extractJsonFromText parses JSON with surrounding text', () => {
  const input = 'prefix text {"status":"ok","meta":{"count":2}} suffix text';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: 'ok',
    meta: { count: 2 },
  });
});

test('extractJsonFromText handles nested braces in objects and strings', () => {
  const input = 'prefix {"outer":{"inner":{"value":1}},"message":"hello {world}"} suffix';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    outer: { inner: { value: 1 } },
    message: 'hello {world}',
  });
});

test('extractJsonFromText handles multiple JSON objects and matcher selection', () => {
  const input = [
    'metadata: {"requestId":"123"}',
    'payload:',
    '{"projectHealth":87,"issues":[],"opportunities":[],"summary":"ok","nested":{"key":"value"}}',
  ].join('\n');

  const first = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(first, {
    requestId: '123',
  });

  const parsed = extractJsonFromText(
    input,
    (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'projectHealth' in value),
  ) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    projectHealth: 87,
    issues: [],
    opportunities: [],
    summary: 'ok',
    nested: { key: 'value' },
  });
});

test('extractJsonFromText skips malformed JSON and falls back to later valid JSON', () => {
  const input = 'note {"broken": } and {"status":"recovered","ok":true}';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: 'recovered',
    ok: true,
  });
});

test('extractJsonFromText returns null for empty, malformed, or non-string input', () => {
  assert.equal(extractJsonFromText(''), null);
  assert.equal(extractJsonFromText('note {"broken": } only'), null);
  assert.equal(extractJsonFromText(undefined as unknown as string), null);
});

test('tryParseJson parses a valid JSON object string', () => {
  assert.deepEqual(tryParseJson('{"ok":true,"count":2}'), {
    ok: true,
    count: 2,
  });
});

test('tryParseJson returns undefined for malformed JSON', () => {
  assert.equal(tryParseJson('{"broken": }'), undefined);
});

test('tryParseJson returns undefined for an empty string', () => {
  assert.equal(tryParseJson(''), undefined);
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
