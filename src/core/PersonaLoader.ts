import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskStore } from "../memory/TaskStore.js";
import { log } from "../utils/logger.js";

export interface SeedData {
  name: string;
  role: string;
  taskTypes: string[];
  focusAreas: string[];
  content: string;
}

export interface StructuredWorkInstructions {
  acceptanceCriteria?: string[];
  filesToModify?: string[];
  guardrails?: string[];
  verificationSteps?: string[];
  references?: string[];
}

export type WorkInstructions = string | StructuredWorkInstructions;

/** Hard rules injected into every worker prompt regardless of persona */
export const GLOBAL_WORKER_RULES = `## AUTONOMOUS AGENT RULES
- SCOPE: Implement exactly what the task asks. No unrelated improvements or cleanups.
- HALT: If you fail the same verification 3 times, STOP and report what's blocking you.
- CLAUDE.MD: Do NOT modify CLAUDE.md — only the brain does that.
- COMMITS: Each commit addresses one logical change. Commit with a descriptive message when done.
- VERIFY: Run tsc and tests before your final commit. Ensure git diff is non-empty.

## PRE-COMMIT CHECKLIST (verify before final commit)
- [ ] All acceptance criteria met (if provided in Work Instructions)
- [ ] No files modified outside the task scope
- [ ] tsc compiles without new errors
- [ ] All tests pass
- [ ] git diff is non-empty and matches task intent
- [ ] No TODO/FIXME/HACK left without explanation`;

/** Format WorkInstructions (string or structured) into Markdown. Empty objects return '' */
export function formatWorkInstructions(wi: WorkInstructions): string {
  if (typeof wi === "string") return wi;
  const sections: string[] = [];
  if (wi.acceptanceCriteria?.length)
    sections.push(
      `### Acceptance Criteria\n${wi.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`,
    );
  if (wi.filesToModify?.length)
    sections.push(
      `### Files to Modify\n${wi.filesToModify.map((f) => `- ${f}`).join("\n")}`,
    );
  if (wi.guardrails?.length)
    sections.push(
      `### Guardrails (DO NOT)\n${wi.guardrails.map((g) => `- ${g}`).join("\n")}`,
    );
  if (wi.verificationSteps?.length)
    sections.push(
      `### Verification Steps\n${wi.verificationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    );
  if (wi.references?.length)
    sections.push(
      `### References\n${wi.references.map((r) => `- ${r}`).join("\n")}`,
    );
  return sections.join("\n\n");
}

const DEFAULT_PERSONA_CONTENT = `## Identity
You are a senior software engineer with full autonomy. No human is reviewing your work in real-time.

## Approach
1. Understand first — read relevant code and trace call sites before making changes.
2. Plan your edit — identify all files that need changing.
3. Implement precisely — follow existing patterns in the codebase.
4. Verify thoroughly — run tsc + tests, check git diff matches your intent.`;

/** Parse a persona seed file with YAML-like frontmatter */
export function parseSeedFile(raw: string): SeedData {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: "unknown",
      role: "Worker",
      taskTypes: [],
      focusAreas: [],
      content: raw.trim(),
    };
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2].trim();

  const getString = (key: string): string => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const getArray = (key: string): string[] => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m"));
    if (!m) return [];
    return m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  return {
    name: getString("name") || "unknown",
    role: getString("role") || "Worker",
    taskTypes: getArray("taskTypes"),
    focusAreas: getArray("focusAreas"),
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
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      try {
        const raw = await readFile(join(this.seedDir, file), "utf-8");
        const seed = parseSeedFile(raw);
        if (seed.name === "unknown") continue;

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

  /** Build the full worker prompt with persona + task + optional work instructions */
  async buildWorkerPrompt(opts: {
    taskDescription: string;
    personaName?: string;
    taskType?: string;
    workInstructions?: WorkInstructions;
  }): Promise<{ prompt: string; systemPrompt: string }> {
    const persona = opts.personaName
      ? await this.taskStore.getPersona(opts.personaName)
      : null;
    const personaContent = persona?.content ?? DEFAULT_PERSONA_CONTENT;
    const role = persona?.role ?? "coding worker";

    const sections = [
      `Execute this coding task:\n\n${opts.taskDescription}`,
      `Read CLAUDE.md for project context and environment rules.`,
      GLOBAL_WORKER_RULES,
    ];

    if (opts.workInstructions) {
      const formatted = formatWorkInstructions(opts.workInstructions);
      if (formatted) {
        sections.push(`## Work Instructions\n${formatted}`);
      }
    }

    const prompt = sections.join("\n\n");
    const systemPrompt = `You are a ${role}.\n\n${personaContent}`;

    return { prompt, systemPrompt };
  }
}
