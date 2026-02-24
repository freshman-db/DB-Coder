import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeedFile, SKILL_MAP, GLOBAL_WORKER_RULES } from './PersonaLoader.js';

describe('parseSeedFile', () => {
  it('should parse frontmatter and content from persona seed file', () => {
    const raw = `---
name: test-persona
role: Tester
taskTypes: [feature, bugfix]
focusAreas: [quality]
---

## Identity
A test persona.

## Principles
- Be thorough`;

    const result = parseSeedFile(raw);
    assert.equal(result.name, 'test-persona');
    assert.equal(result.role, 'Tester');
    assert.deepEqual(result.taskTypes, ['feature', 'bugfix']);
    assert.deepEqual(result.focusAreas, ['quality']);
    assert.ok(result.content.includes('## Identity'));
    assert.ok(result.content.includes('Be thorough'));
    assert.ok(!result.content.includes('---'));
  });

  it('should handle missing optional fields gracefully', () => {
    const raw = `---
name: minimal
role: Worker
---

Content here.`;

    const result = parseSeedFile(raw);
    assert.equal(result.name, 'minimal');
    assert.deepEqual(result.taskTypes, []);
    assert.deepEqual(result.focusAreas, []);
  });

  it('should parse Critical Actions and Anti-Patterns sections into content', () => {
    const raw = `---
name: enhanced-persona
role: Engineer
taskTypes: [feature]
focusAreas: [quality]
---

## Identity
An enhanced persona.

## Critical Actions

### ALWAYS
- Always do X

### NEVER
- Never do Y

## Anti-Patterns
- NEVER pattern Z

## Quality Gates

### Correctness
- Gate 1`;

    const result = parseSeedFile(raw);
    assert.ok(result.content.includes('## Critical Actions'), 'Content should include Critical Actions');
    assert.ok(result.content.includes('### ALWAYS'), 'Content should include ALWAYS subsection');
    assert.ok(result.content.includes('### NEVER'), 'Content should include NEVER subsection');
    assert.ok(result.content.includes('## Anti-Patterns'), 'Content should include Anti-Patterns');
    assert.ok(result.content.includes('NEVER pattern Z'), 'Content should include specific anti-pattern');
    assert.ok(result.content.includes('### Correctness'), 'Content should include Quality Gates subcategories');
  });
});

describe('SKILL_MAP', () => {
  it('should map known task types to skill lists', () => {
    assert.ok(SKILL_MAP.feature.length > 0);
    assert.ok(SKILL_MAP.bugfix.length > 0);
    assert.ok(SKILL_MAP.refactoring.length > 0);
  });

  it('should include verification skill for all types', () => {
    for (const [, skills] of Object.entries(SKILL_MAP)) {
      const hasVerification = skills.some(s => s.includes('verification'));
      assert.ok(hasVerification, `All task types should include a verification skill`);
    }
  });
});

describe('GLOBAL_WORKER_RULES', () => {
  it('should contain essential rule categories', () => {
    assert.ok(GLOBAL_WORKER_RULES.includes('SCOPE'), 'Should include SCOPE rule');
    assert.ok(GLOBAL_WORKER_RULES.includes('HALT'), 'Should include HALT rule');
    assert.ok(GLOBAL_WORKER_RULES.includes('GIT REALITY'), 'Should include GIT REALITY rule');
    assert.ok(GLOBAL_WORKER_RULES.includes('NO SILENT FAILURES'), 'Should include NO SILENT FAILURES rule');
    assert.ok(GLOBAL_WORKER_RULES.includes('TYPE SAFETY'), 'Should include TYPE SAFETY rule');
    assert.ok(GLOBAL_WORKER_RULES.includes('VERIFY'), 'Should include VERIFY rule');
  });

  it('should be a non-empty string', () => {
    assert.ok(typeof GLOBAL_WORKER_RULES === 'string');
    assert.ok(GLOBAL_WORKER_RULES.length > 100, 'Rules should have substantial content');
  });
});
