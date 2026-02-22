import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatorPrompt } from './evaluator.js';

describe('evaluatorPrompt', () => {
  const taskDescription = 'Fix incorrect totals in invoice export';
  const planSummary = '- Reproduce with fixture\n- Normalize rounding in serializer';
  const scanContext = 'Users report mismatched totals in CSV exports for tax-inclusive invoices.';

  it('includes all four scoring dimensions and interpolates task context', () => {
    const prompt = evaluatorPrompt(taskDescription, planSummary, scanContext);

    assert.ok(prompt.includes(taskDescription));
    assert.ok(prompt.includes(planSummary));
    assert.ok(prompt.includes(scanContext));

    assert.ok(prompt.includes('problemLegitimacy'));
    assert.ok(prompt.includes('solutionProportionality'));
    assert.ok(prompt.includes('expectedComplexity'));
    assert.ok(prompt.includes('historicalSuccess'));
  });

  it('includes MCP section when mcpServerNames are provided', () => {
    const prompt = evaluatorPrompt(taskDescription, planSummary, scanContext, ['server']);

    assert.ok(prompt.includes('## Available MCP Tools'));
    assert.ok(prompt.includes('server'));
  });

  it('omits MCP section when mcpServerNames are undefined or empty', () => {
    const promptWithoutNames = evaluatorPrompt(taskDescription, planSummary, scanContext);
    const promptWithEmptyNames = evaluatorPrompt(taskDescription, planSummary, scanContext, []);

    assert.ok(!promptWithoutNames.includes('## Available MCP Tools'));
    assert.ok(!promptWithEmptyNames.includes('## Available MCP Tools'));
  });

  it('includes output format JSON specification', () => {
    const prompt = evaluatorPrompt(taskDescription, planSummary, scanContext);

    assert.ok(prompt.includes('## Output Format'));
    assert.ok(prompt.includes('Output a single JSON object'));
    assert.ok(prompt.includes('"problemLegitimacy"'));
    assert.ok(prompt.includes('"solutionProportionality"'));
    assert.ok(prompt.includes('"expectedComplexity"'));
    assert.ok(prompt.includes('"historicalSuccess"'));
    assert.ok(prompt.includes('"total"'));
    assert.ok(prompt.includes('"reasoning"'));
  });

  it('includes agent guidance when provided and omits it when undefined', () => {
    const agentGuidance = 'Bias toward rejection unless user impact is concrete and measurable.';
    const promptWithGuidance = evaluatorPrompt(taskDescription, planSummary, scanContext, undefined, agentGuidance);
    const promptWithoutGuidance = evaluatorPrompt(taskDescription, planSummary, scanContext, undefined, undefined);

    assert.ok(promptWithGuidance.includes(agentGuidance));
    assert.ok(!promptWithoutGuidance.includes(agentGuidance));
  });
});
