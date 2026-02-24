# Worker Specialization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce Persona + Skill + Subtask system to specialize worker execution based on task type.

**Architecture:** Brain decides task with persona/taskType/subtasks metadata. PersonaLoader reads persona from DB (seeded from files). Worker sessions receive persona via `appendSystemPrompt` and skill references via prompt. Complex tasks get split into subtasks, each executed in a fresh worker session. Two-stage review (Brain spec compliance + Codex quality) gates merging.

**Tech Stack:** TypeScript, Node.js `node:test`, PostgreSQL (porsager/postgres), Claude Code CLI (stream-json)

---

### Task 1: Add `personas` table to database schema

**Files:**
- Modify: `src/memory/TaskStore.ts` (SCHEMA_SQL, lines 11-195)
- Modify: `src/memory/types.ts` (add Persona interface)
- Test: `src/core/PersonaLoader.test.ts` (created in Task 3)

**Step 1: Add Persona interface to types**

Add to `src/memory/types.ts` after the `SubTaskRecord` interface (line 45):

```typescript
export interface Persona {
  id: number;
  name: string;
  role: string;
  content: string;
  task_types: string[];
  focus_areas: string[];
  usage_count: number;
  success_rate: number;
  created_at: Date;
  updated_at: Date;
}
```

**Step 2: Add CREATE TABLE to SCHEMA_SQL**

Append to the end of `SCHEMA_SQL` in `src/memory/TaskStore.ts` (before the closing backtick at line 195):

```sql
CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  task_types TEXT[] DEFAULT '{}',
  focus_areas TEXT[] DEFAULT '{}',
  usage_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 3: Add persona CRUD methods to TaskStore**

Add these methods to the `TaskStore` class in `src/memory/TaskStore.ts`:

```typescript
async getPersona(name: string): Promise<Persona | null> {
  const rows = await this.sql<Persona[]>`SELECT * FROM personas WHERE name = ${name} LIMIT 1`;
  return rows[0] ?? null;
}

async listPersonas(): Promise<Persona[]> {
  return this.sql<Persona[]>`SELECT * FROM personas ORDER BY name`;
}

async upsertPersona(p: { name: string; role: string; content: string; task_types: string[]; focus_areas: string[] }): Promise<Persona> {
  const rows = await this.sql<Persona[]>`
    INSERT INTO personas (name, role, content, task_types, focus_areas)
    VALUES (${p.name}, ${p.role}, ${p.content}, ${p.task_types}, ${p.focus_areas})
    ON CONFLICT (name) DO UPDATE SET
      role = EXCLUDED.role,
      content = EXCLUDED.content,
      task_types = EXCLUDED.task_types,
      focus_areas = EXCLUDED.focus_areas,
      updated_at = NOW()
    RETURNING *`;
  return rows[0];
}

async updatePersonaStats(name: string, success: boolean): Promise<void> {
  await this.sql`
    UPDATE personas SET
      usage_count = usage_count + 1,
      success_rate = (success_rate * usage_count + ${success ? 1 : 0}) / (usage_count + 1),
      updated_at = NOW()
    WHERE name = ${name}`;
}

async updatePersonaContent(name: string, content: string): Promise<void> {
  await this.sql`UPDATE personas SET content = ${content}, updated_at = NOW() WHERE name = ${name}`;
}
```

**Step 4: Run build to verify no type errors**

Run: `npm run build`
Expected: Clean compilation

**Step 5: Commit**

```bash
git add src/memory/types.ts src/memory/TaskStore.ts
git commit -m "feat: add personas table schema and CRUD methods"
```

---

### Task 2: Create persona seed files

**Files:**
- Create: `personas/_template.md`
- Create: `personas/feature-builder.md`
- Create: `personas/refactoring-expert.md`
- Create: `personas/bugfix-debugger.md`
- Create: `personas/test-engineer.md`
- Create: `personas/security-auditor.md`
- Create: `personas/performance-optimizer.md`
- Create: `personas/frontend-specialist.md`

**Step 1: Create template file**

Create `personas/_template.md`:

```markdown
---
name: template-name
role: Role Title
taskTypes: [feature, bugfix, refactoring, test, security, performance, frontend, code-quality, docs]
focusAreas: [area1, area2]
---

## Identity
Describe role, expertise, and approach.

## Principles
- Key working principle 1
- Key working principle 2

## Quality Gates
- Gate 1
- Gate 2
```

**Step 2: Create feature-builder persona**

Create `personas/feature-builder.md`:

```markdown
---
name: feature-builder
role: Senior Feature Engineer
taskTypes: [feature, docs]
focusAreas: [functionality, user-experience, test-coverage]
---

## Identity
You build new features with a test-first approach. You focus on clean interfaces, proper error handling, and comprehensive test coverage.

## Principles
- Write a failing test before any production code
- Keep interfaces minimal — expose only what's needed
- Handle errors explicitly — never catch-ignore
- Commit after each logical unit of work

## Quality Gates
- All new code has corresponding tests
- No new tsc errors
- Error paths are tested
- Public API is documented with JSDoc
```

**Step 3: Create refactoring-expert persona**

Create `personas/refactoring-expert.md`:

```markdown
---
name: refactoring-expert
role: Senior Refactoring Engineer
taskTypes: [refactoring, code-quality]
focusAreas: [code-quality, architecture, maintainability]
---

## Identity
You restructure code for clarity and maintainability without changing behavior. You are methodical — verify behavior before and after every change.

## Principles
- Never change behavior — refactoring is structure-only
- Run tests before AND after every change
- One concern per commit
- Reduce function length, nesting depth, and coupling

## Quality Gates
- All existing tests still pass
- No new tsc errors
- Functions remain under 80 lines
- Nesting depth ≤ 3 levels
```

**Step 4: Create bugfix-debugger persona**

Create `personas/bugfix-debugger.md`:

```markdown
---
name: bugfix-debugger
role: Senior Debugging Engineer
taskTypes: [bugfix]
focusAreas: [root-cause-analysis, regression-prevention, error-handling]
---

## Identity
You fix bugs by finding root causes, never by guessing. You follow the 4-phase debugging process: investigate, analyze patterns, hypothesize, then implement fix.

## Principles
- Reproduce the bug first — write a failing test that demonstrates it
- Find the root cause before writing any fix
- Fix the cause, not the symptom
- Add regression tests to prevent recurrence

## Quality Gates
- Failing test exists that reproduces the bug
- Root cause is identified and documented in commit message
- Fix addresses root cause, not symptom
- Regression test passes
```

**Step 5: Create test-engineer persona**

Create `personas/test-engineer.md`:

```markdown
---
name: test-engineer
role: Senior Test Engineer
taskTypes: [test]
focusAreas: [test-coverage, edge-cases, test-quality]
---

## Identity
You write thorough, maintainable tests. You focus on edge cases, error paths, and boundary conditions that other engineers miss.

## Principles
- Test behavior, not implementation details
- Cover happy path, error path, and edge cases
- Each test should fail for exactly one reason
- Use descriptive test names that document expected behavior

## Quality Gates
- Tests are independent — no shared mutable state
- Edge cases and error paths are covered
- Test names describe the behavior being tested
- No flaky tests — deterministic inputs and outputs
```

**Step 6: Create security-auditor persona**

Create `personas/security-auditor.md`:

```markdown
---
name: security-auditor
role: Security Engineer
taskTypes: [security]
focusAreas: [input-validation, injection-prevention, data-exposure]
---

## Identity
You find and fix security vulnerabilities. You think like an attacker — what inputs could cause harm? What data could leak?

## Principles
- Validate all external input at system boundaries
- Never trust user input, URL parameters, or external API responses
- Check for injection (SQL, command, XSS) in every string handling path
- Ensure sensitive data (passwords, tokens, keys) never appears in logs

## Quality Gates
- No unvalidated external input reaches internal logic
- No string concatenation in SQL or shell commands
- Sensitive data is redacted in logs
- Security fixes include tests proving the vulnerability is closed
```

**Step 7: Create performance-optimizer persona**

Create `personas/performance-optimizer.md`:

```markdown
---
name: performance-optimizer
role: Performance Engineer
taskTypes: [performance]
focusAreas: [latency, resource-usage, scalability]
---

## Identity
You optimize for measurable performance improvements. You profile before optimizing and measure after — no guessing.

## Principles
- Measure before and after — no optimization without evidence
- Fix the bottleneck, not the code that looks slow
- Prefer algorithmic improvements over micro-optimizations
- Avoid N+1 queries, unnecessary awaits in loops, missing parallelization

## Quality Gates
- Benchmark or profile data supports the change
- No regression in correctness (all tests pass)
- Optimization is documented with before/after metrics
- No premature optimization of non-bottleneck code
```

**Step 8: Create frontend-specialist persona**

Create `personas/frontend-specialist.md`:

```markdown
---
name: frontend-specialist
role: Frontend Engineer
taskTypes: [frontend]
focusAreas: [ui-ux, accessibility, browser-compatibility]
---

## Identity
You build clean, accessible, and responsive frontend interfaces. You care about user experience and follow web standards.

## Principles
- Sanitize all dynamic HTML content (DOMPurify or equivalent)
- Use semantic HTML elements
- Ensure keyboard navigation works
- Test across viewport sizes

## Quality Gates
- No innerHTML without sanitization
- Interactive elements are keyboard-accessible
- No console errors in browser
- Responsive layout works at common breakpoints
```

**Step 9: Commit**

```bash
git add personas/
git commit -m "feat: add persona seed files for 7 worker specializations"
```

---

### Task 3: Create PersonaLoader module

**Files:**
- Create: `src/core/PersonaLoader.ts`
- Create: `src/core/PersonaLoader.test.ts`

**Step 1: Write the failing test**

Create `src/core/PersonaLoader.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test';
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
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/core/PersonaLoader.test.js`
Expected: FAIL — module not found

**Step 3: Write PersonaLoader implementation**

Create `src/core/PersonaLoader.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore } from '../memory/TaskStore.js';
import { log } from '../utils/logger.js';

export interface SeedData {
  name: string;
  role: string;
  taskTypes: string[];
  focusAreas: string[];
  content: string;
}

/** Task type → skill names to reference in worker prompt */
export const SKILL_MAP: Record<string, string[]> = {
  feature: ['superpowers:test-driven-development', 'superpowers:verification-before-completion'],
  bugfix: ['superpowers:systematic-debugging', 'superpowers:verification-before-completion'],
  refactoring: ['superpowers:verification-before-completion'],
  test: ['superpowers:test-driven-development', 'superpowers:verification-before-completion'],
  security: ['superpowers:verification-before-completion'],
  performance: ['superpowers:verification-before-completion'],
  frontend: ['superpowers:verification-before-completion'],
  'code-quality': ['superpowers:verification-before-completion'],
  docs: ['superpowers:verification-before-completion'],
};

const DEFAULT_PERSONA_CONTENT = `## Identity
You are a general-purpose coding worker. Execute the task precisely.

## Principles
- Read the task carefully before starting
- Write tests for new behavior
- Commit with descriptive messages

## Quality Gates
- All tests pass
- No new tsc errors`;

/** Parse a persona seed file with YAML-like frontmatter */
export function parseSeedFile(raw: string): SeedData {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { name: 'unknown', role: 'Worker', taskTypes: [], focusAreas: [], content: raw.trim() };
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2].trim();

  const getString = (key: string): string => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const getArray = (key: string): string[] => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*\\[(.*)\\]$`, 'm'));
    if (!m) return [];
    return m[1].split(',').map(s => s.trim()).filter(Boolean);
  };

  return {
    name: getString('name') || 'unknown',
    role: getString('role') || 'Worker',
    taskTypes: getArray('taskTypes'),
    focusAreas: getArray('focusAreas'),
    content,
  };
}

export class PersonaLoader {
  constructor(
    private taskStore: TaskStore,
    private seedDir: string,
  ) {}

  /** Load seed files into DB (skip existing names) */
  async seedFromFiles(): Promise<number> {
    let loaded = 0;
    let files: string[];
    try {
      files = await readdir(this.seedDir);
    } catch {
      log.warn(`Persona seed directory not found: ${this.seedDir}`);
      return 0;
    }

    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('_')) continue;
      try {
        const raw = await readFile(join(this.seedDir, file), 'utf-8');
        const seed = parseSeedFile(raw);
        if (seed.name === 'unknown') continue;

        const existing = await this.taskStore.getPersona(seed.name);
        if (!existing) {
          await this.taskStore.upsertPersona({
            name: seed.name,
            role: seed.role,
            content: seed.content,
            task_types: seed.taskTypes,
            focus_areas: seed.focusAreas,
          });
          loaded++;
          log.info(`Seeded persona: ${seed.name}`);
        }
      } catch (err) {
        log.warn(`Failed to load persona seed ${file}:`, err);
      }
    }
    return loaded;
  }

  /** Get persona content by name, with fallback to default */
  async getPersonaContent(name: string | undefined): Promise<string> {
    if (!name) return DEFAULT_PERSONA_CONTENT;
    const persona = await this.taskStore.getPersona(name);
    return persona?.content ?? DEFAULT_PERSONA_CONTENT;
  }

  /** Get skill list for a task type */
  getSkillsForType(taskType: string | undefined): string[] {
    if (!taskType) return SKILL_MAP.feature;
    return SKILL_MAP[taskType] ?? SKILL_MAP.feature;
  }

  /** Build the full worker prompt with persona + skills + task */
  async buildWorkerPrompt(opts: {
    taskDescription: string;
    personaName?: string;
    taskType?: string;
  }): Promise<{ prompt: string; systemPrompt: string }> {
    const personaContent = await this.getPersonaContent(opts.personaName);
    const skills = this.getSkillsForType(opts.taskType);

    const prompt = `Execute this coding task:

${opts.taskDescription}

Read CLAUDE.md for project context and environment rules.
Do NOT modify CLAUDE.md — only the brain does that.

## Skills to use
${skills.map(s => `- ${s}`).join('\n')}

Commit with a descriptive message when done.`;

    const persona = await this.taskStore.getPersona(opts.personaName ?? '');
    const role = persona?.role ?? 'coding worker';
    const systemPrompt = `You are a ${role}.\n\n${personaContent}`;

    return { prompt, systemPrompt };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/core/PersonaLoader.test.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/PersonaLoader.ts src/core/PersonaLoader.test.ts
git commit -m "feat: add PersonaLoader with seed parsing and skill mapping"
```

---

### Task 4: Extend brainDecide to output persona/taskType/subtasks

**Files:**
- Modify: `src/core/MainLoop.ts` (brainDecide method, lines 489-555)

**Step 1: Update the brainDecide JSON schema**

In `src/core/MainLoop.ts`, update the `brainDecide` method's prompt. Replace the final JSON instruction block (the line starting with `Respond with EXACTLY this JSON`):

```typescript
Respond with EXACTLY this JSON (no markdown, no extra text):
{"task": "specific description", "priority": 0-3, "persona": "persona-name", "taskType": "feature|bugfix|refactoring|test|security|performance|frontend|code-quality|docs", "subtasks": [{"description": "subtask 1", "order": 1}], "reasoning": "why"}

Rules for persona/taskType:
- persona: choose from available personas (feature-builder, refactoring-expert, bugfix-debugger, test-engineer, security-auditor, performance-optimizer, frontend-specialist)
- taskType: categorize the task (feature, bugfix, refactoring, test, security, performance, frontend, code-quality, docs)
- subtasks: ONLY for complex tasks that need 2+ independent steps. Most tasks should NOT have subtasks. Each subtask must be independently completable and verifiable.
```

**Step 2: Update the return type and parsing**

Update the `brainDecide` method return type and JSON parsing to include the new fields:

```typescript
private async brainDecide(projectPath: string): Promise<{
    taskDescription: string | null;
    priority?: number;
    persona?: string;
    taskType?: string;
    subtasks?: Array<{ description: string; order: number }>;
    costUsd: number;
  }> {
```

And in the `try` block parsing:

```typescript
try {
  const parsed = JSON.parse(result.text);
  const taskDesc = parsed.task && typeof parsed.task === 'string' ? parsed.task : null;
  return {
    taskDescription: taskDesc,
    priority: typeof parsed.priority === 'number' ? parsed.priority : 2,
    persona: typeof parsed.persona === 'string' ? parsed.persona : undefined,
    taskType: typeof parsed.taskType === 'string' ? parsed.taskType : undefined,
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks : undefined,
    costUsd: result.costUsd,
  };
} catch {
```

**Step 3: Run build to verify**

Run: `npm run build`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: extend brainDecide to output persona, taskType, subtasks"
```

---

### Task 5: Refactor workerExecute to use PersonaLoader

**Files:**
- Modify: `src/core/MainLoop.ts` (workerExecute method, lines 674-697; constructor; property declarations)

**Step 1: Add PersonaLoader as a MainLoop dependency**

Add import at top of `src/core/MainLoop.ts`:

```typescript
import { PersonaLoader } from './PersonaLoader.js';
```

Add property to `MainLoop` class:

```typescript
private personaLoader: PersonaLoader;
```

Initialize in constructor (after existing property assignments):

```typescript
this.personaLoader = new PersonaLoader(taskStore, join(config.projectPath, 'personas'));
```

Add import for `join` from `node:path` if not already imported.

**Step 2: Add persona seeding to start()**

In the `start()` method, add persona seeding early (after lock acquisition, before the main loop):

```typescript
await this.personaLoader.seedFromFiles();
```

**Step 3: Update workerExecute signature and implementation**

Replace the `workerExecute` method:

```typescript
private async workerExecute(task: Task, opts?: {
  persona?: string;
  taskType?: string;
  subtaskDescription?: string;
}): Promise<SessionResult> {
  const description = opts?.subtaskDescription ?? task.task_description;
  const { prompt, systemPrompt } = await this.personaLoader.buildWorkerPrompt({
    taskDescription: description,
    personaName: opts?.persona,
    taskType: opts?.taskType,
  });

  return this.workerSession.run(prompt, {
    permissionMode: 'bypassPermissions',
    maxTurns: 30,
    maxBudget: this.config.values.claude.maxTaskBudget,
    cwd: this.config.projectPath,
    timeout: this.config.values.autonomy.subtaskTimeout * 1000,
    model: this.config.values.claude.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
    appendSystemPrompt: systemPrompt,
  });
}
```

**Step 4: Update the workerExecute call site in runCycle**

In `runCycle()`, update the call to `workerExecute` (around line 350) to pass the new fields from `brainDecide`. Find:

```typescript
const workerResult = await this.workerExecute(task);
```

This will be fully replaced in Task 6 (subtask execution). For now, update the `runCycle` where the `decision` is used to store persona/taskType on the task, and pass them to `workerExecute`:

After `task = await this.taskStore.createTask(...)`, store the metadata:

```typescript
// Store persona/taskType metadata in subtasks field for now
if (decision.persona || decision.taskType) {
  await this.taskStore.updateTask(task.id, {
    subtasks: decision.subtasks?.map((st, i) => ({
      id: String(i + 1),
      description: st.description,
      executor: 'claude' as const,
      status: 'pending' as const,
    })) ?? [],
  });
}
```

Then update the workerExecute call:

```typescript
const workerResult = await this.workerExecute(task, {
  persona: decision.persona,
  taskType: decision.taskType,
});
```

Note: For queued tasks (the `if (queued)` branch), `decision` doesn't exist. In that branch, call `workerExecute(task)` without options — PersonaLoader falls back to defaults.

**Step 5: Run build and tests**

Run: `npm run build && npm test`
Expected: Clean compilation, existing tests pass

**Step 6: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: wire PersonaLoader into workerExecute for persona-based specialization"
```

---

### Task 6: Implement subtask execution loop

**Files:**
- Modify: `src/core/MainLoop.ts` (runCycle, add new `executeSubtasks` method)

**Step 1: Add the executeSubtasks method**

Add to `MainLoop` class:

```typescript
private async executeSubtasks(
  task: Task,
  subtasks: Array<{ description: string; order: number }>,
  opts: { persona?: string; taskType?: string; baselineErrors: number; startCommit: string },
): Promise<{ success: boolean; sessionId?: string }> {
  const sorted = [...subtasks].sort((a, b) => a.order - b.order);

  for (let i = 0; i < sorted.length; i++) {
    const st = sorted[i];
    log.info(`Subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 100)}`);

    // Update subtask status to running
    const currentSubtasks = (task.subtasks ?? []).map((s, idx) =>
      idx === i ? { ...s, status: 'running' as const } : s,
    );
    await this.taskStore.updateTask(task.id, { subtasks: currentSubtasks });

    // Execute in fresh worker session
    const result = await this.workerExecute(task, {
      persona: opts.persona,
      taskType: opts.taskType,
      subtaskDescription: st.description,
    });

    if (result.costUsd > 0) await this.costTracker.addCost(task.id, result.costUsd);

    await this.taskStore.addLog({
      task_id: task.id,
      phase: 'execute',
      agent: 'claude-code',
      input_summary: `subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 80)}`,
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    // Per-subtask hard verify
    const verification = await this.hardVerify(opts.baselineErrors, opts.startCommit, this.config.projectPath);
    if (!verification.passed) {
      log.warn(`Subtask ${i + 1} verification failed: ${verification.reason}`);

      // Try to fix
      if (result.sessionId) {
        const fixResult = await this.workerFix(result.sessionId, verification.reason ?? 'Unknown', task);
        if (fixResult.costUsd > 0) await this.costTracker.addCost(task.id, fixResult.costUsd);

        const reVerify = await this.hardVerify(opts.baselineErrors, opts.startCommit, this.config.projectPath);
        if (!reVerify.passed) {
          log.warn(`Subtask ${i + 1} re-verification failed: ${reVerify.reason}`);
          // Mark subtask failed, abort remaining
          const failedSubtasks = (task.subtasks ?? []).map((s, idx) =>
            idx === i ? { ...s, status: 'failed' as const, result: reVerify.reason } : s,
          );
          await this.taskStore.updateTask(task.id, { subtasks: failedSubtasks });
          return { success: false };
        }
      } else {
        const failedSubtasks = (task.subtasks ?? []).map((s, idx) =>
          idx === i ? { ...s, status: 'failed' as const, result: verification.reason } : s,
        );
        await this.taskStore.updateTask(task.id, { subtasks: failedSubtasks });
        return { success: false };
      }
    }

    // Mark subtask done
    const doneSubtasks = (task.subtasks ?? []).map((s, idx) =>
      idx === i ? { ...s, status: 'done' as const } : s,
    );
    await this.taskStore.updateTask(task.id, { subtasks: doneSubtasks });
    // Re-read task for updated subtask state
    task = (await this.taskStore.getTask(task.id))!;
  }

  return { success: true };
}
```

**Step 2: Wire subtask execution into runCycle**

In `runCycle()`, replace the section from worker execution through re-verification (roughly the block from `// 5. Worker executes` through `this.eventBus.emit(this.makeEvent('fix', 'after', ...))`) with branching logic:

```typescript
// 5. Execute (subtask loop or single shot)
this.setState('executing');
const guardErrors = await this.eventBus.emitAndWait(this.makeEvent('execute', 'before', { taskDescription: task.task_description }));
if (guardErrors.length > 0) {
  log.warn(`Guard blocked execution: ${guardErrors[0].message}`);
  await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
  await switchBranch(originalBranch, projectPath).catch(() => {});
  await this.cleanupTaskBranch(branchName);
  this.setCurrentTaskId(null);
  this.setState('idle');
  return false;
}

let workerPassed: boolean;

if (decision?.subtasks && decision.subtasks.length > 0) {
  // Subtask execution loop
  const result = await this.executeSubtasks(task, decision.subtasks, {
    persona: decision.persona,
    taskType: decision.taskType,
    baselineErrors,
    startCommit,
  });
  workerPassed = result.success;
  this.eventBus.emit(this.makeEvent('execute', 'after', { startCommit, result: { costUsd: 0, durationMs: 0 } }));
} else {
  // Single-shot execution (existing flow)
  const workerResult = await this.workerExecute(task, {
    persona: decision?.persona,
    taskType: decision?.taskType,
  });
  if (workerResult.costUsd > 0) await this.costTracker.addCost(task.id, workerResult.costUsd);

  await this.taskStore.addLog({
    task_id: task.id,
    phase: 'execute',
    agent: 'claude-code',
    input_summary: truncate(task.task_description, SUMMARY_PREVIEW_LEN),
    output_summary: workerResult.text.slice(0, SUMMARY_PREVIEW_LEN),
    cost_usd: workerResult.costUsd,
    duration_ms: workerResult.durationMs,
  });
  this.eventBus.emit(this.makeEvent('execute', 'after', { startCommit, result: { costUsd: workerResult.costUsd, durationMs: workerResult.durationMs } }));

  // Hard verification
  this.setState('reviewing');
  const verifyStart = Date.now();
  const verification = await this.hardVerify(baselineErrors, startCommit, projectPath);
  await this.taskStore.addLog({
    task_id: task.id,
    phase: 'verify',
    agent: 'tsc',
    input_summary: `baseline=${baselineErrors}, startCommit=${startCommit}`,
    output_summary: verification.passed ? 'PASS' : `FAIL: ${verification.reason}`,
    cost_usd: 0,
    duration_ms: Date.now() - verifyStart,
  });
  this.eventBus.emit(this.makeEvent('verify', 'after', { verification, startCommit }));

  // Fix attempt if verification failed
  if (!verification.passed && workerResult.sessionId) {
    log.warn(`Hard verification failed: ${verification.reason}`);
    const fixResult = await this.workerFix(workerResult.sessionId, verification.reason ?? 'Unknown error', task);
    if (fixResult.costUsd > 0) await this.costTracker.addCost(task.id, fixResult.costUsd);

    const changedFilesForCommit = await getModifiedAndAddedFiles(projectPath).catch(() => []);
    await commitAll('db-coder: fix verification issues', projectPath, changedFilesForCommit).catch(() => {});
    const reVerify = await this.hardVerify(baselineErrors, startCommit, projectPath);
    if (!reVerify.passed) {
      log.warn(`Re-verification still failed: ${reVerify.reason}`);
    }
    verification.passed = reVerify.passed;
    verification.reason = reVerify.reason;
    this.eventBus.emit(this.makeEvent('fix', 'after', { verification }));
  }

  workerPassed = verification.passed;
}
```

Then use `workerPassed` in the downstream logic instead of `verification.passed`.

**Step 3: Ensure `decision` variable is accessible**

The `decision` variable is currently scoped inside the `else` branch of the queued check. It needs to be accessible later. Declare it before the `if (queued)` block:

```typescript
let decision: { persona?: string; taskType?: string; subtasks?: Array<{ description: string; order: number }> } | undefined;
```

And assign it in the `else` block where brain decides.

**Step 4: Run build and tests**

Run: `npm run build && npm test`
Expected: Clean compilation, existing tests pass

**Step 5: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: add subtask execution loop with per-subtask verification"
```

---

### Task 7: Add spec compliance review (Stage 1)

**Files:**
- Modify: `src/core/MainLoop.ts` (add `specReview` method, update runCycle merge decision)

**Step 1: Add the specReview method**

Add to `MainLoop` class:

```typescript
private async specReview(
  task: Task,
  startCommit: string,
  projectPath: string,
): Promise<{ passed: boolean; missing: string[]; extra: string[]; concerns: string[] }> {
  const diff = await getDiffSince(startCommit, projectPath).catch(() => '(diff unavailable)');
  const subtaskList = (task.subtasks ?? []).map(s => `- ${s.description}`).join('\n');

  const prompt = `You are reviewing code changes for spec compliance. DO NOT trust commit messages — only examine the actual code.

## Original Task
${task.task_description}

${subtaskList ? `## Subtasks\n${subtaskList}\n` : ''}
## Git Diff
\`\`\`diff
${diff.slice(0, 15000)}
\`\`\`

## Review Instructions
1. Does the implementation fully cover the task requirements?
2. Are there any missing requirements that were not implemented?
3. Are there any changes that go beyond the scope (extra work not requested)?
4. Any concerns about the implementation approach?

Respond with EXACTLY this JSON (no markdown, no extra text):
{"passed": true/false, "missing": ["..."], "extra": ["..."], "concerns": ["..."]}`;

  const result = await this.brainThink(prompt);
  if (result.costUsd > 0 && task.id) {
    await this.costTracker.addCost(task.id, result.costUsd);
  }

  await this.taskStore.addLog({
    task_id: task.id,
    phase: 'review',
    agent: 'brain-spec',
    input_summary: 'Spec compliance review',
    output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
  });

  try {
    const parsed = JSON.parse(result.text);
    return {
      passed: parsed.passed === true,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      extra: Array.isArray(parsed.extra) ? parsed.extra : [],
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
    };
  } catch {
    log.warn('Spec review returned unparseable JSON, treating as PASS');
    return { passed: true, missing: [], extra: [], concerns: [] };
  }
}
```

Note: You need to check if `getDiffSince` exists. If not, use the existing git helper or add one. Check `src/utils/git.ts` for available functions.

**Step 2: Wire spec review into runCycle merge decision**

In `runCycle()`, after the worker execution and hard verification block, before the Codex review section (around `// 8. Codex review`), add:

```typescript
// 7.5 Spec compliance review (Stage 1)
let specReviewPassed = true;
if (workerPassed) {
  this.setState('reviewing');
  const spec = await this.specReview(task, startCommit, projectPath);
  specReviewPassed = spec.passed;
  if (!specReviewPassed) {
    log.info(`Spec review: FAIL — missing: ${spec.missing.join(', ')}, extra: ${spec.extra.join(', ')}`);
  } else {
    log.info(`Spec review: PASS${spec.concerns.length > 0 ? ` (concerns: ${spec.concerns.join(', ')})` : ''}`);
  }
}
```

**Step 3: Update the merge decision**

Update the `shouldMerge` calculation:

```typescript
const shouldMerge = workerPassed && specReviewPassed && codexReviewPassed;
```

**Step 4: Skip Codex review if spec review failed**

Wrap the Codex review section in a condition:

```typescript
let codexReviewPassed = true;
if (workerPassed && specReviewPassed) {
  // existing Codex review code...
}
```

**Step 5: Run build and tests**

Run: `npm run build && npm test`
Expected: Clean compilation, existing tests pass

**Step 6: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: add spec compliance review (Stage 1) before Codex quality review"
```

---

### Task 8: Add persona stats update to brainReflect

**Files:**
- Modify: `src/core/MainLoop.ts` (brainReflect, runCycle)

**Step 1: Pass persona name to brainReflect**

Update `brainReflect` signature to accept persona name:

```typescript
private async brainReflect(
  task: Task,
  outcome: string,
  verification: { passed: boolean; reason?: string },
  projectPath: string,
  personaName?: string,
): Promise<void> {
```

**Step 2: Update persona stats after reflection**

At the end of `brainReflect`, add:

```typescript
// Update persona usage stats
if (personaName) {
  await this.personaLoader.taskStore.updatePersonaStats(personaName, outcome === 'success').catch(err =>
    log.warn(`Failed to update persona stats for ${personaName}:`, err),
  );
}
```

Note: This requires `taskStore` to be accessible via `personaLoader`. Since `PersonaLoader` takes `taskStore` in its constructor, it's available. Add a public getter or make it a public property. Or just call `this.taskStore.updatePersonaStats(personaName, ...)` directly since `MainLoop` already has `this.taskStore`.

Simpler approach — just use `this.taskStore` directly:

```typescript
if (personaName) {
  await this.taskStore.updatePersonaStats(personaName, outcome === 'success').catch(err =>
    log.warn(`Failed to update persona stats for ${personaName}:`, err),
  );
}
```

**Step 3: Update the brainReflect call in runCycle**

Find the call to `brainReflect` in `runCycle` and add the persona argument:

```typescript
await this.brainReflect(task, outcome, verification, projectPath, decision?.persona);
```

**Step 4: Run build and tests**

Run: `npm run build && npm test`
Expected: Clean compilation, existing tests pass

**Step 5: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: track persona usage stats on task completion"
```

---

### Task 9: Add persona API endpoints

**Files:**
- Modify: `src/server/routes.ts`

**Step 1: Add GET /api/personas endpoint**

Add a route handler in `src/server/routes.ts`:

```typescript
addRoute('GET', '/api/personas', async (_req, res, ctx) => {
  const personas = await ctx.taskStore.listPersonas();
  json(res, personas);
});
```

**Step 2: Add PUT /api/personas/:name endpoint**

```typescript
addRoute('PUT', '/api/personas/:name', async (req, res, ctx, params) => {
  const body = await readBody(req);
  if (!body.content || typeof body.content !== 'string') {
    throw new HttpError(400, 'content is required');
  }
  await ctx.taskStore.updatePersonaContent(params.name, body.content);
  json(res, { ok: true });
});
```

**Step 3: Run build**

Run: `npm run build`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat: add persona API endpoints (list, update)"
```

---

### Task 10: Create custom skill definitions

**Files:**
- Create: `.claude/skills/db-coder-security-review/SKILL.md`
- Create: `.claude/skills/db-coder-perf-optimization/SKILL.md`

**Step 1: Create security review skill**

Create `.claude/skills/db-coder-security-review/SKILL.md`:

```markdown
---
name: db-coder-security-review
description: Use when performing security-focused code review or fixing security vulnerabilities
---

## Security Review Process

### Step 1: Identify attack surface
- List all external inputs (HTTP params, env vars, file reads, DB queries)
- Map data flow from input to output

### Step 2: Check OWASP Top 10
- Injection (SQL, command, XSS): No string concatenation in queries or shell commands
- Broken auth: Tokens validated, sessions managed properly
- Sensitive data exposure: No secrets in logs, env vars not leaked
- Security misconfiguration: Default configs reviewed
- Input validation: All external input validated at boundary

### Step 3: Fix and verify
- Write a test that demonstrates the vulnerability
- Implement the fix
- Verify the test now passes
- Check for similar patterns elsewhere in codebase
```

**Step 2: Create performance optimization skill**

Create `.claude/skills/db-coder-perf-optimization/SKILL.md`:

```markdown
---
name: db-coder-perf-optimization
description: Use when optimizing code performance, fixing N+1 queries, or reducing latency
---

## Performance Optimization Process

### Step 1: Profile and measure
- Identify the bottleneck with concrete evidence (timing, query count, memory)
- Establish a baseline measurement

### Step 2: Optimize
- Fix N+1 queries: batch or join instead of loop queries
- Parallelize independent async operations: `Promise.all()` instead of sequential await
- Remove unnecessary work: dead code, redundant computations, unused imports
- Cache repeated computations where inputs are stable

### Step 3: Verify
- Measure again — confirm improvement
- Run all tests — no correctness regression
- Document the before/after improvement in commit message
```

**Step 3: Commit**

```bash
git add .claude/skills/
git commit -m "feat: add custom skill definitions for security review and performance optimization"
```

---

### Task 11: Integration test

**Files:**
- Modify: `src/core/MainLoop.test.ts`

**Step 1: Add PersonaLoader unit tests**

These were already created in Task 3. Verify they pass:

Run: `npm run build && node --test dist/core/PersonaLoader.test.js`
Expected: All PASS

**Step 2: Run full test suite**

Run: `npm test`
Expected: All existing tests PASS

**Step 3: Run build to verify no type errors**

Run: `npm run build`
Expected: Clean compilation with 0 errors

**Step 4: Manual verification**

Verify the end-to-end flow by checking:
1. `personas/` directory contains 7 seed files + template
2. `.claude/skills/` contains 2 custom skill directories
3. `src/core/PersonaLoader.ts` exists and exports `PersonaLoader`, `parseSeedFile`, `SKILL_MAP`
4. `src/core/MainLoop.ts` references `PersonaLoader` and has `executeSubtasks` and `specReview` methods

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "test: verify integration of persona + skill + subtask system"
```
