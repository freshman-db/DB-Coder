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
    const persona = opts.personaName ? await this.taskStore.getPersona(opts.personaName) : null;
    const personaContent = persona?.content ?? DEFAULT_PERSONA_CONTENT;
    const role = persona?.role ?? 'coding worker';
    const skills = this.getSkillsForType(opts.taskType);

    const prompt = `Execute this coding task:

${opts.taskDescription}

Read CLAUDE.md for project context and environment rules.
Do NOT modify CLAUDE.md — only the brain does that.

## Skills to use
${skills.map(s => `- ${s}`).join('\n')}

Commit with a descriptive message when done.`;

    const systemPrompt = `You are a ${role}.\n\n${personaContent}`;

    return { prompt, systemPrompt };
  }
}
