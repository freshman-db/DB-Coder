/**
 * Tests for HTML escaping in app.js render functions.
 *
 * Since app.js is a browser-side script that uses DOM APIs (document.createElement),
 * we verify escaping via:
 *   1. Static source analysis — ensure all known dynamic values are wrapped in escapeHtml()
 *   2. A Node-equivalent escapeHtml to confirm the escaping logic is correct
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Read app.js from the source tree (always available, unlike dist/web/app.js which
// depends on the cp step in the build script).
const appSource = readFileSync(
  new URL('../web/app.js', import.meta.url),
  'utf-8',
);

// Node-equivalent of the browser escapeHtml (same semantics as textContent→innerHTML)
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── escapeHtml correctness ───

test('escapeHtml escapes angle brackets', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml escapes ampersands', () => {
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
});

test('escapeHtml escapes double quotes', () => {
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
});

test('escapeHtml handles empty string', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml handles normal text unchanged', () => {
  assert.equal(escapeHtml('hello world 123'), 'hello world 123');
});

test('escapeHtml handles mixed malicious input', () => {
  const input = '"><img src=x onerror=alert(1)>';
  const output = escapeHtml(input);
  assert.ok(!output.includes('<'), 'should not contain unescaped <');
  assert.ok(!output.includes('>'), 'should not contain unescaped >');
});

// ─── Static analysis: renderTaskDetail escapes all dynamic values ───

test('renderTaskDetail escapes task.id', () => {
  const fn = extractFunction(appSource, 'renderTaskDetail');
  assert.ok(fn, 'renderTaskDetail should exist in app.js');

  // The meta-value for ID should use escapeHtml
  assert.ok(
    fn.includes('escapeHtml(String(task.id'),
    'task.id in meta-value should be wrapped with escapeHtml(String(...))',
  );
});

test('renderTaskDetail escapes task.git_branch', () => {
  const fn = extractFunction(appSource, 'renderTaskDetail');
  assert.ok(fn);
  assert.ok(
    fn.includes("escapeHtml(String(task.git_branch || '-'))"),
    'task.git_branch should be escaped',
  );
});

test('renderTaskDetail escapes task.created_at', () => {
  const fn = extractFunction(appSource, 'renderTaskDetail');
  assert.ok(fn);
  assert.ok(
    fn.includes("escapeHtml(String(task.created_at || '-'))"),
    'task.created_at should be escaped',
  );
});

test('renderTaskDetail escapes task.phase', () => {
  const fn = extractFunction(appSource, 'renderTaskDetail');
  assert.ok(fn);
  assert.ok(
    fn.includes("escapeHtml(String(task.phase || '-'))"),
    'task.phase should be escaped',
  );
});

test('renderTaskDetail escapes task.id in deleteTask onclick', () => {
  const fn = extractFunction(appSource, 'renderTaskDetail');
  assert.ok(fn);
  assert.ok(
    fn.includes("deleteTask('${escapeHtml(String(task.id"),
    'task.id in onclick handler should be escaped',
  );
});

// ─── Static analysis: renderDashboard escapes currentTaskId ───

test('getPatrolStateDesc escapes currentTaskId', () => {
  const fn = extractFunction(appSource, 'getPatrolStateDesc');
  assert.ok(fn, 'getPatrolStateDesc should exist');
  assert.ok(
    fn.includes('escapeHtml(String(currentTaskId'),
    'currentTaskId in detail string should be escaped',
  );
});

test('renderDashboard escapes st.currentTaskId in anchor', () => {
  const fn = extractFunction(appSource, 'renderDashboard');
  assert.ok(fn, 'renderDashboard should exist');
  assert.ok(
    fn.includes('escapeHtml(String(st.currentTaskId))'),
    'st.currentTaskId should be escaped in dashboard anchor',
  );
});

// ─── Static analysis: renderTaskRow escapes t.id ───

test('renderTaskRow escapes t.id in onclick', () => {
  const fn = extractFunction(appSource, 'renderTaskRow');
  assert.ok(fn, 'renderTaskRow should exist');
  assert.ok(
    fn.includes('escapeHtml(String(t.id'),
    't.id in onclick should be escaped',
  );
});

// ─── Static analysis: renderPlans escapes d.id ───

test('renderPlans escapes d.id in onclick', () => {
  const fn = extractFunction(appSource, 'renderPlans');
  assert.ok(fn, 'renderPlans should exist');
  assert.ok(
    fn.includes('escapeHtml(String(d.id'),
    'd.id in plans list onclick should be escaped',
  );
});

// ─── Static analysis: renderPlanReviewView escapes draft.id ───

test('renderPlanReviewView escapes draft.id', () => {
  const fn = extractFunction(appSource, 'renderPlanReviewView');
  assert.ok(fn, 'renderPlanReviewView should exist');
  assert.ok(
    fn.includes('escapeHtml(String(draft.id'),
    'draft.id in heading should be escaped',
  );
});

// ─── Static analysis: memory results escape item.source ───

test('renderMemory escapes item.source', () => {
  const fn = extractFunction(appSource, 'renderMemory');
  assert.ok(fn, 'renderMemory should exist');
  assert.ok(
    fn.includes('escapeHtml(String(item.source))'),
    'item.source in memory results should be escaped',
  );
});

// ─── Edge case: null/undefined coercion via String() ───

test('String() coercion handles null safely', () => {
  const nullVal: string | null = null;
  const undefVal: string | undefined = undefined;
  assert.equal(escapeHtml(String(nullVal ?? '')), '');
  assert.equal(escapeHtml(String(undefVal ?? '')), '');
});

test('String() coercion handles numeric IDs', () => {
  assert.equal(escapeHtml(String(42)), '42');
});

test('String() coercion handles UUID', () => {
  const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  assert.equal(escapeHtml(String(uuid)), uuid);
});

// ─── Helper to extract a function body by name from source ───

function extractFunction(source: string, name: string): string | null {
  // Match "function name(" or "async function name(" and extract until balanced braces
  const patterns = [
    new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=`),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;

    const startIdx = match.index;
    // Find the first opening brace after the match
    const braceIdx = source.indexOf('{', startIdx);
    if (braceIdx === -1) continue;

    let depth = 0;
    let i = braceIdx;
    while (i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          return source.slice(startIdx, i + 1);
        }
      }
      i++;
    }
  }

  return null;
}
