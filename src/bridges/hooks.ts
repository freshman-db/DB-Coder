import type {
  HookEvent,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';

export type HookRegistry = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export interface ToolStat {
  name: string;
  callCount: number;
  totalDurationMs: number;
  errorCount: number;
}

export interface HookCallbacks {
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  onToolResult?: (toolName: string, toolInput: unknown, toolResponse: unknown) => void;
  onStop?: () => void;
  onSessionEnd?: (reason: string) => void;
}

const EMPTY_OUTPUT: HookJSONOutput = {};

export function buildHooks(callbacks?: HookCallbacks): HookRegistry {
  if (!callbacks) return {};
  const hooks: HookRegistry = {};

  if (callbacks.onToolUse) {
    const cb = callbacks.onToolUse;
    hooks.PreToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PreToolUse') {
          const typed = input as PreToolUseHookInput;
          cb(typed.tool_name, typed.tool_input);
        }
        return EMPTY_OUTPUT;
      }],
    }];
  }

  if (callbacks.onToolResult) {
    const cb = callbacks.onToolResult;
    hooks.PostToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PostToolUse') {
          const typed = input as PostToolUseHookInput;
          cb(typed.tool_name, typed.tool_input, typed.tool_response);
        }
        return EMPTY_OUTPUT;
      }],
    }];
  }

  if (callbacks.onStop) {
    const cb = callbacks.onStop;
    hooks.Stop = [{
      hooks: [async () => {
        cb();
        return EMPTY_OUTPUT;
      }],
    }];
  }

  if (callbacks.onSessionEnd) {
    const cb = callbacks.onSessionEnd;
    hooks.SessionEnd = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'SessionEnd') {
          const typed = input as SessionEndHookInput;
          cb(String(typed.reason));
        }
        return EMPTY_OUTPUT;
      }],
    }];
  }

  return hooks;
}
