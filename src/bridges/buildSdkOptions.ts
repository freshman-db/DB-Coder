import type {
  Options,
  SdkPluginConfig,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionOptions } from "./ClaudeCodeSession.js";

const CLAUDE_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_PACKAGE_DIR",
  "CLAUDE_DEV_HOST",
  "CLAUDE_DEV_PORT",
];

const DEFAULT_CLAUDE_MEM_MODEL = "claude-opus-4-6";

function cleanEnv(claudeMemModel?: string): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of CLAUDE_ENV_VARS) delete env[key];
  env.CLAUDE_MEM_MODEL = claudeMemModel || DEFAULT_CLAUDE_MEM_MODEL;
  return env;
}

export interface SdkSessionOptions {
  prompt: string;
  options: Options;
  timeoutMs?: number;
}

export interface SdkExtras {
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  plugins?: SdkPluginConfig[];
  agents?: Options["agents"];
  mcpServers?: Options["mcpServers"];
}

export function buildSdkOptions(
  prompt: string,
  opts: SessionOptions,
  extras?: SdkExtras,
): SdkSessionOptions {
  // --- Permission mode ---
  const options: Options = {
    permissionMode: opts.permissionMode,
  };

  if (opts.permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  // --- Always: settings sources (loads CLAUDE.md + settings) ---
  options.settingSources = ["user", "project", "local"];

  // --- System prompt: always preset, optionally with append ---
  if (opts.appendSystemPrompt) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: opts.appendSystemPrompt,
    };
  } else {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
    };
  }

  // --- Always: clean env vars ---
  options.env = cleanEnv(opts.model);

  // --- Direct mappings ---
  if (opts.maxBudget !== undefined) options.maxBudgetUsd = opts.maxBudget;
  if (opts.resumeSessionId !== undefined) options.resume = opts.resumeSessionId;
  if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
  if (opts.model !== undefined) options.model = opts.model;
  if (opts.thinking !== undefined) options.thinking = opts.thinking;
  if (opts.effort !== undefined) options.effort = opts.effort;
  if (opts.cwd !== undefined) options.cwd = opts.cwd;
  if (opts.allowedTools !== undefined) options.allowedTools = opts.allowedTools;
  if (opts.disallowedTools !== undefined)
    options.disallowedTools = opts.disallowedTools;

  // --- JSON schema → outputFormat ---
  if (opts.jsonSchema !== undefined) {
    options.outputFormat = {
      type: "json_schema",
      schema: opts.jsonSchema as Record<string, unknown>,
    };
  }

  // --- Timeout → AbortController + timeoutMs ---
  let timeoutMs: number | undefined;
  if (opts.timeout !== undefined) {
    timeoutMs = opts.timeout;
    options.abortController = new AbortController();
  }

  // --- Extras passthrough ---
  if (extras?.hooks) options.hooks = extras.hooks;
  if (extras?.plugins) options.plugins = extras.plugins;
  if (extras?.agents) options.agents = extras.agents;
  if (extras?.mcpServers) options.mcpServers = extras.mcpServers;

  return { prompt, options, timeoutMs };
}
