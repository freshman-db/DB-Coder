/**
 * runBrainThink — Shared brain session helper used by BrainPhase and ReviewPhase.
 *
 * Extracted from MainLoop to avoid phase-to-phase imports.
 * Both BrainPhase and ReviewPhase import this standalone function.
 */

import type { Config } from "../../config/Config.js";
import { resolveModelId } from "../../config/Config.js";
import type {
  ClaudeCodeSession,
  SessionResult,
} from "../../bridges/ClaudeCodeSession.js";
import type { RuntimeAdapter } from "../../runtime/RuntimeAdapter.js";
import { log } from "../../utils/logger.js";

// Thin seam: Phase 3 will change parameter type to RuntimeAdapter.
// Currently kept as union; call sites pass ClaudeCodeSession for now.
export type BrainThinkSession = ClaudeCodeSession | RuntimeAdapter;

/** Type guard: distinguish RuntimeAdapter from ClaudeCodeSession */
function isRuntimeAdapter(rt: BrainThinkSession): rt is RuntimeAdapter {
  return "capabilities" in rt;
}

export async function runBrainThink(
  brainSession: BrainThinkSession,
  config: Config,
  prompt: string,
  opts?: { jsonSchema?: object; resumeSessionId?: string },
): Promise<SessionResult> {
  // Phase 3: dispatch to RuntimeAdapter.run() when brainSession is a RuntimeAdapter
  if (isRuntimeAdapter(brainSession)) {
    throw new Error(
      "runBrainThink: RuntimeAdapter dispatch not yet implemented — Phase 3",
    );
  }

  const isResume = !!opts?.resumeSessionId;
  const result = await brainSession.run(prompt, {
    permissionMode: "bypassPermissions",
    maxTurns: 200,
    cwd: config.projectPath,
    timeout: 900_000,
    model: resolveModelId(config.values.brain.model),
    disallowedTools: ["Edit", "Write", "NotebookEdit"],
    appendSystemPrompt: isResume
      ? undefined
      : "You are the brain of an autonomous coding agent. Read CLAUDE.md for context. Do not modify files — only analyze and decide.",
    jsonSchema: opts?.jsonSchema,
    resumeSessionId: opts?.resumeSessionId,
  });

  if (isResume) {
    const u = result.usage;
    const total = u.inputTokens || 1;
    log.info(
      `brainThink resume cache: read=${u.cacheReadInputTokens}/${total} (${((u.cacheReadInputTokens / total) * 100).toFixed(0)}%)`,
    );
  }

  return result;
}
