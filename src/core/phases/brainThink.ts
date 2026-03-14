/**
 * runBrainThink — Shared brain session helper used by BrainPhase, ReviewPhase,
 * MaintenancePhase, and ChainScanner.
 *
 * Extracted from MainLoop to avoid phase-to-phase imports.
 * All callers pass a RuntimeAdapter (Phase 3).
 */

import type { Config } from "../../config/Config.js";
import type {
  RuntimeAdapter,
  RunResult,
} from "../../runtime/RuntimeAdapter.js";
import { log } from "../../utils/logger.js";

/**
 * Check if a runtime supports session resume.
 * Returns true only for unconditional support (sessionPersistence === true).
 * Conditional support (e.g. codex-cli with full-auto) is treated as "not
 * guaranteed" for brain read-only sessions where we'd lose context on failure.
 */
function supportsResume(rt: RuntimeAdapter): boolean {
  return rt.capabilities.sessionPersistence === true;
}

export async function runBrainThink(
  brainRuntime: RuntimeAdapter,
  config: Config,
  prompt: string,
  opts?: { jsonSchema?: object; resumeSessionId?: string; model?: string },
): Promise<RunResult> {
  // Caller can override model for phase-specific routing (plan, reflect, etc.).
  // Falls back to routing.brain.model → legacy brain.model.
  // Model aliases are normalized at Config construction time.
  const model =
    opts?.model ||
    config.values.routing.brain.model ||
    config.values.brain.model;

  // Only attempt resume if the runtime unconditionally supports it.
  // If resume is conditional (e.g. codex-cli), the caller's abbreviated prompt
  // would lose phase1/chain context, so we force a full prompt instead.
  const canResume = supportsResume(brainRuntime);
  const effectiveResumeId =
    canResume && opts?.resumeSessionId ? opts.resumeSessionId : undefined;
  const isResume = !!effectiveResumeId;

  if (opts?.resumeSessionId && !canResume) {
    log.info(
      `brainThink: resume requested but runtime "${brainRuntime.name}" does not unconditionally support it — using full prompt`,
    );
  }

  const result = await brainRuntime.run(prompt, {
    cwd: config.projectPath,
    model,
    timeout: 900_000,
    maxTurns: 200,
    outputSchema: opts?.jsonSchema,
    readOnly: true,
    resumeSessionId: effectiveResumeId,
    systemPrompt: isResume
      ? undefined
      : "You are the brain of an autonomous coding agent. Read CLAUDE.md for context. Do not modify files — only analyze and decide.",
    disallowedTools: ["Edit", "Write", "NotebookEdit"],
  });

  if (isResume && result.numTurns !== undefined) {
    log.info(
      `brainThink resume completed: turns=${result.numTurns}, cost=$${result.costUsd.toFixed(3)}`,
    );
  }

  return result;
}
