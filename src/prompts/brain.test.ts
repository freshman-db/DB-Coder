import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DynamicPromptContext } from '../evolution/types.js';
import {
  brainMcpGuidance,
  formatDynamicContext,
  planPrompt,
  reflectPrompt,
  scanPrompt,
} from './brain.js';

describe('scanPrompt', () => {
  it('includes JSON schema markers for core fields', () => {
    const prompt = scanPrompt('/tmp/project', 'normal', '', '');

    assert.ok(prompt.includes('"issues": [{'));
    assert.ok(prompt.includes('"opportunities": [{'));
    assert.ok(prompt.includes('"projectHealth": number (0-100)'));
  });

  it('includes the project path in the prompt body', () => {
    const projectPath = '/tmp/db-coder-project';
    const prompt = scanPrompt(projectPath, 'quick', 'Changed README', 'None');

    assert.ok(prompt.includes(`Scan the project at ${projectPath}.`));
  });
});

describe('planPrompt', () => {
  it('includes existing task descriptions when provided', () => {
    const existingTasks = '- [queued] Fix flaky scheduler test\n- [completed] Refactor prompt parser';
    const prompt = planPrompt('Analysis text', 'Memory text', existingTasks);

    assert.ok(prompt.includes('Fix flaky scheduler test'));
    assert.ok(prompt.includes('Refactor prompt parser'));
  });

  it('handles an empty existing task list gracefully', () => {
    const prompt = planPrompt('Analysis text', 'Memory text', '');

    assert.ok(prompt.includes('Existing tasks (queued, completed, blocked, and failed'));
    assert.ok(prompt.includes('\nNone\n'));
    assert.ok(!prompt.includes('undefined'));
  });
});

describe('reflectPrompt', () => {
  it('includes task description and review results', () => {
    const taskDescription = 'Add validation for malformed webhook payloads';
    const result = 'Implemented schema checks and added failing-case tests.';
    const reviewSummary = 'Review passed after requesting one assertion improvement.';
    const prompt = reflectPrompt(taskDescription, result, reviewSummary);

    assert.ok(prompt.includes(`Task: ${taskDescription}`));
    assert.ok(prompt.includes(`Result: ${result}`));
    assert.ok(prompt.includes(`Review: ${reviewSummary}`));
  });

  it('includes recurring pattern escalation guidance for behavioral adjustments', () => {
    const prompt = reflectPrompt(
      'Refactor status endpoint',
      'Updated handler and tests',
      'Review flagged recurring missing-test issue',
    );

    assert.ok(prompt.includes('## Recurring Pattern Escalation'));
    assert.ok(prompt.includes('BEHAVIORAL adjustment'));
    assert.ok(prompt.includes('Technique adjustment (narrow):'));
    assert.ok(prompt.includes('Behavioral adjustment (required for recurring issues):'));
    assert.ok(prompt.includes('always add or update unit tests for the changed code'));
    assert.ok(prompt.includes('category "standard"'));
  });
});

describe('formatDynamicContext', () => {
  it('renders every section when all dynamic context fields are populated', () => {
    const ctx: DynamicPromptContext = {
      learnedPatterns: ['Prefer table-driven tests for parser edge cases'],
      antiPatterns: ['Avoid prototype-level method patching in tests'],
      trendContext: 'Health: 52/100 (degrading)',
      activeAdjustments: ['[strategy] Strengthen error-path test coverage'],
      goalContext: 'Goal progress',
    };
    const rendered = formatDynamicContext(ctx);

    assert.ok(rendered.includes('## Learned Patterns'));
    assert.ok(rendered.includes('## Anti-Patterns (avoid these)'));
    assert.ok(rendered.includes('## Project Trends'));
    assert.ok(rendered.includes('## Active Adjustments'));
    assert.ok(rendered.includes('## Goal progress'));
  });

  it('omits learned/anti-pattern and adjustment sections when those lists are empty', () => {
    const ctx: DynamicPromptContext = {
      learnedPatterns: [],
      antiPatterns: [],
      trendContext: 'Health: 60/100 (stable)',
      activeAdjustments: [],
      goalContext: 'Goal progress',
    };
    const rendered = formatDynamicContext(ctx);

    assert.ok(!rendered.includes('## Learned Patterns'));
    assert.ok(!rendered.includes('## Anti-Patterns (avoid these)'));
    assert.ok(!rendered.includes('## Active Adjustments'));
    assert.ok(rendered.includes('## Project Trends'));
    assert.ok(rendered.includes('## Goal progress'));
  });

  it('renders only learned-pattern memory section when only memories are present', () => {
    const ctx: DynamicPromptContext = {
      learnedPatterns: ['Always include timeout coverage for runProcess consumers'],
      antiPatterns: [],
      trendContext: '',
      activeAdjustments: [],
      goalContext: '',
    };
    const rendered = formatDynamicContext(ctx);

    assert.ok(rendered.includes('## Learned Patterns'));
    assert.ok(!rendered.includes('## Anti-Patterns (avoid these)'));
    assert.ok(!rendered.includes('## Project Trends'));
    assert.ok(!rendered.includes('## Active Adjustments'));
  });
});

describe('brainMcpGuidance', () => {
  it('maps known server names to guidance entries', () => {
    const guidance = brainMcpGuidance(['serena', 'context7']);

    assert.ok(guidance.includes('## Available MCP Tools'));
    assert.ok(guidance.includes('Serena'));
    assert.ok(guidance.includes('Context7'));
  });

  it('returns empty guidance for an empty server list', () => {
    assert.equal(brainMcpGuidance([]), '');
  });
});
