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
import { log } from "../../utils/logger.js";

export async function runBrainThink(
  brainSession: ClaudeCodeSession,
  config: Config,
  prompt: string,
  opts?: { jsonSchema?: object; resumeSessionId?: string },
): Promise<SessionResult> {
  const isResume = !!opts?.resumeSessionId;
  const result = await brainSession.run(prompt, {
    permissionMode: "bypassPermissions",
    maxTurns: 200,
    cwd: config.projectPath,
    timeout: 900_000,
    model: resolveModelId(config.values.brain.model),
    thinking: { type: "adaptive" },
    effort: "high",
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
