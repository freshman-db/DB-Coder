import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeReviews,
  extractIssueCategories,
  countTscErrors,
  setCountTscErrorsDepsForTests,
} from './MainLoop.js';
import type { ReviewResult, ReviewIssue } from '../bridges/CodingAgent.js';

// --- mergeReviews ---

describe('mergeReviews', () => {
  const makeReview = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
    passed: true,
    summary: 'OK',
    issues: [],
    cost_usd: 0,
    ...overrides,
  });

  it('should pass when both reviewers pass with no issues', () => {
    const result = mergeReviews(makeReview(), makeReview());
    assert.ok(result.passed);
    assert.equal(result.mustFix.length, 0);
    assert.equal(result.shouldFix.length, 0);
  });

  it('should promote matching issues to mustFix', () => {
    const claudeIssue: ReviewIssue = {
      description: 'Missing null check in user handler',
      severity: 'medium',
      file: 'src/handler.ts',
      source: 'claude',
    };
    const codexIssue: ReviewIssue = {
      description: 'null check missing in user handler function',
      severity: 'high',
      file: 'src/handler.ts',
      source: 'codex',
    };

    const result = mergeReviews(
      makeReview({ issues: [claudeIssue] }),
      makeReview({ issues: [codexIssue] }),
    );

    assert.equal(result.mustFix.length, 1);
    // Should use the higher severity
    assert.equal(result.mustFix[0].severity, 'high');
  });

  it('should put non-matching issues into shouldFix', () => {
    const claudeIssue: ReviewIssue = {
      description: 'Type error in config parser',
      severity: 'medium',
      file: 'src/config.ts',
      source: 'claude',
    };
    const codexIssue: ReviewIssue = {
      description: 'Memory leak in event handler',
      severity: 'low',
      file: 'src/events.ts',
      source: 'codex',
    };

    const result = mergeReviews(
      makeReview({ issues: [claudeIssue] }),
      makeReview({ issues: [codexIssue] }),
    );

    assert.equal(result.mustFix.length, 0);
    assert.equal(result.shouldFix.length, 2);
  });

  it('should fail when reviewer explicitly failed without issues', () => {
    const result = mergeReviews(
      makeReview({ passed: false, issues: [] }),
      makeReview({ passed: true }),
    );

    assert.ok(!result.passed);
    assert.equal(result.shouldFix.length, 1);
    assert.match(result.shouldFix[0].description, /Claude reviewer explicitly failed/);
  });

  it('should fail on critical mustFix issues', () => {
    const claudeIssue: ReviewIssue = {
      description: 'SQL injection vulnerability in query builder',
      severity: 'critical',
      file: 'src/db.ts',
      source: 'claude',
    };
    const codexIssue: ReviewIssue = {
      description: 'SQL injection in query builder',
      severity: 'critical',
      file: 'src/db.ts',
      source: 'codex',
    };

    const result = mergeReviews(
      makeReview({ issues: [claudeIssue] }),
      makeReview({ issues: [codexIssue] }),
    );

    assert.ok(!result.passed);
    assert.equal(result.mustFix.length, 1);
  });

  it('should pass with low-severity mustFix', () => {
    const claudeIssue: ReviewIssue = {
      description: 'Style issue in variable naming',
      severity: 'low',
      file: 'src/util.ts',
      source: 'claude',
    };
    const codexIssue: ReviewIssue = {
      description: 'Variable naming style issue',
      severity: 'low',
      file: 'src/util.ts',
      source: 'codex',
    };

    const result = mergeReviews(
      makeReview({ issues: [claudeIssue] }),
      makeReview({ issues: [codexIssue] }),
    );

    assert.ok(result.passed);
    assert.equal(result.mustFix.length, 1);
  });

  it('should include summary from both reviewers', () => {
    const result = mergeReviews(
      makeReview({ summary: 'Claude found 2 issues' }),
      makeReview({ summary: 'Codex found 1 issue' }),
    );

    assert.match(result.summary, /Claude: Claude found 2 issues/);
    assert.match(result.summary, /Codex: Codex found 1 issue/);
  });
});

// --- extractIssueCategories ---

describe('extractIssueCategories', () => {
  it('should extract type-error category', () => {
    const categories = extractIssueCategories([
      { description: 'Type error in function argument', severity: 'medium', source: 'claude' },
    ]);
    assert.ok(categories.includes('type-error'));
  });

  it('should extract null-safety category', () => {
    const categories = extractIssueCategories([
      { description: 'Possible null reference', severity: 'high', source: 'codex' },
    ]);
    assert.ok(categories.includes('null-safety'));
  });

  it('should extract security category', () => {
    const categories = extractIssueCategories([
      { description: 'XSS vulnerability in template', severity: 'critical', source: 'claude' },
    ]);
    assert.ok(categories.includes('security'));
  });

  it('should extract multiple categories', () => {
    const categories = extractIssueCategories([
      { description: 'Type mismatch in API endpoint', severity: 'medium', source: 'claude' },
      { description: 'Missing test coverage', severity: 'low', source: 'codex' },
      { description: 'SQL injection risk', severity: 'critical', source: 'claude' },
    ]);
    assert.ok(categories.includes('type-error'));
    assert.ok(categories.includes('missing-test'));
    assert.ok(categories.includes('security'));
  });

  it('should fall back to severity-based category', () => {
    const categories = extractIssueCategories([
      { description: 'Something very unusual happened here', severity: 'medium', source: 'claude' },
    ]);
    assert.ok(categories.includes('severity-medium'));
  });

  it('should return empty array for no issues', () => {
    const categories = extractIssueCategories([]);
    assert.equal(categories.length, 0);
  });
});

// --- countTscErrors ---

describe('countTscErrors', () => {
  afterEach(() => {
    setCountTscErrorsDepsForTests();
  });

  it('should return 0 if no tsconfig.json', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => false,
    });

    const count = await countTscErrors('/some/project');
    assert.equal(count, 0);
  });

  it('should count error lines from tsc output', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: `src/foo.ts(1,1): error TS2304: Cannot find name 'x'.
src/bar.ts(5,10): error TS2307: Cannot find module './baz.js'.
src/ok.ts(1,1): warning: some warning
Found 2 errors.`,
        stderr: '',
      }),
    });

    const count = await countTscErrors('/project');
    assert.equal(count, 2);
  });

  it('should return 0 for clean tsc output', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });

    const count = await countTscErrors('/project');
    assert.equal(count, 0);
  });

  it('should return -1 on process failure', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => { throw new Error('Process timed out'); },
    });

    const count = await countTscErrors('/project');
    assert.equal(count, -1);
  });

  it('should count errors from stderr too', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: `src/a.ts(3,5): error TS2345: Argument type mismatch.`,
      }),
    });

    const count = await countTscErrors('/project');
    assert.equal(count, 1);
  });
});
