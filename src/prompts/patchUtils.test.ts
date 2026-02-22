import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPatches, validatePatchedPrompt } from './patchUtils.js';
import type { PromptPatch } from '../evolution/types.js';

describe('applyPatches', () => {
  const base = `You are a coding assistant.

## Instructions
1. Read files
2. Make changes

## Output Format
Output as JSON:
{
  "issues": [],
  "projectHealth": 50
}`;

  it('should prepend content', () => {
    const patches: PromptPatch[] = [
      { op: 'prepend', content: 'IMPORTANT: Be careful.', reason: 'safety' },
    ];
    const result = applyPatches(base, patches);
    assert.ok(result.startsWith('IMPORTANT: Be careful.\n'));
    assert.ok(result.includes('You are a coding assistant.'));
  });

  it('should append content', () => {
    const patches: PromptPatch[] = [
      { op: 'append', content: 'Remember to test.', reason: 'testing' },
    ];
    const result = applyPatches(base, patches);
    assert.ok(result.endsWith('Remember to test.'));
    assert.ok(result.includes('You are a coding assistant.'));
  });

  it('should replace a section', () => {
    const patches: PromptPatch[] = [
      { op: 'replace_section', section: 'Instructions', content: '1. Think carefully\n2. Plan first\n3. Execute', reason: 'improve' },
    ];
    const result = applyPatches(base, patches);
    assert.ok(result.includes('## Instructions'));
    assert.ok(result.includes('1. Think carefully'));
    assert.ok(!result.includes('1. Read files'));
    assert.ok(result.includes('## Output Format'));
  });

  it('should remove a section', () => {
    const patches: PromptPatch[] = [
      { op: 'remove_section', section: 'Instructions', content: '', reason: 'unnecessary' },
    ];
    const result = applyPatches(base, patches);
    assert.ok(!result.includes('## Instructions'));
    assert.ok(!result.includes('1. Read files'));
    assert.ok(result.includes('## Output Format'));
    assert.ok(result.includes('You are a coding assistant.'));
  });

  it('should apply multiple patches in order', () => {
    const patches: PromptPatch[] = [
      { op: 'prepend', content: 'PREFIX', reason: 'a' },
      { op: 'append', content: 'SUFFIX', reason: 'b' },
    ];
    const result = applyPatches(base, patches);
    assert.ok(result.startsWith('PREFIX\n'));
    assert.ok(result.endsWith('SUFFIX'));
  });

  it('should return base if section not found (replace_section)', () => {
    const patches: PromptPatch[] = [
      { op: 'replace_section', section: 'NonExistent', content: 'new', reason: 'test' },
    ];
    const result = applyPatches(base, patches);
    assert.equal(result, base);
  });

  it('should return base if section not found (remove_section)', () => {
    const patches: PromptPatch[] = [
      { op: 'remove_section', section: 'NonExistent', content: '', reason: 'test' },
    ];
    const result = applyPatches(base, patches);
    assert.equal(result, base);
  });

  it('should return base for unknown patch operation', () => {
    const patches = [
      { op: 'unknown', content: 'ignored', reason: 'test' },
    ] as unknown as PromptPatch[];
    const result = applyPatches(base, patches);
    assert.equal(result, base);
  });

  it('should return base on empty patches array', () => {
    const result = applyPatches(base, []);
    assert.equal(result, base);
  });

  it('should handle section at end of text', () => {
    const text = `Intro

## Section A
Content A

## Section B
Content B`;
    const patches: PromptPatch[] = [
      { op: 'remove_section', section: 'Section B', content: '', reason: 'test' },
    ];
    const result = applyPatches(text, patches);
    assert.ok(result.includes('## Section A'));
    assert.ok(result.includes('Content A'));
    assert.ok(!result.includes('## Section B'));
    assert.ok(!result.includes('Content B'));
  });
});

describe('validatePatchedPrompt', () => {
  it('should pass for scan prompt with required markers', () => {
    const prompt = 'Scan the project.\nOutput JSON:\n{"issues": [], "projectHealth": 50}';
    assert.ok(validatePatchedPrompt(prompt, 'scan'));
  });

  it('should fail for scan prompt missing markers', () => {
    const prompt = 'Scan the project. Just give me text.';
    assert.ok(!validatePatchedPrompt(prompt, 'scan'));
  });

  it('should pass for executor prompt (no markers required)', () => {
    const prompt = 'Execute this task.';
    assert.ok(validatePatchedPrompt(prompt, 'executor'));
  });

  it('should pass for brain_system prompt (no markers required)', () => {
    const prompt = 'You are the Brain.';
    assert.ok(validatePatchedPrompt(prompt, 'brain_system'));
  });

  it('should fail for reviewer prompt missing passed marker', () => {
    const prompt = 'Review code.\nOutput: {"issues": [], "summary": "ok"}';
    assert.ok(!validatePatchedPrompt(prompt, 'reviewer'));
  });

  it('should pass for reviewer prompt with all markers', () => {
    const prompt = 'Review code.\nOutput: {"passed": true, "issues": [], "summary": "ok"}';
    assert.ok(validatePatchedPrompt(prompt, 'reviewer'));
  });
});
