import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeedFile, SKILL_MAP } from './PersonaLoader.js';

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
