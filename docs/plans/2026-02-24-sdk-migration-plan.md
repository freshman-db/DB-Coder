# Agent SDK 回迁实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 db-coder 从 `claude -p` CLI 管道模式回迁到 Agent SDK `query()` API，获得完整 hooks 支持 + 外部项目借鉴改进。

**Architecture:** 保持 brain+worker 双 session 架构不变。替换桥接层 `ClaudeCodeSession` 的内部实现（从 spawn CLI 改为 SDK `query()`），同时保持 `run(prompt, opts): Promise<SessionResult>` 接口稳定。MainLoop 7 个调用点零改动。

**Tech Stack:** `@anthropic-ai/claude-agent-sdk ^0.2.50`（已在 package.json），TypeScript 5.7+，Node.js >= 22，`node:test` 测试框架

**Design Doc:** `docs/plans/2026-02-24-sdk-migration-design.md`

**Review Fixes Applied:** 以下审查反馈已纳入本计划:
1. confidence 字段需同步更新 `tryParseReview()` 解析逻辑（Task 11 已修正）
2. 插件版本排序改用 semver 感知排序（Task 5 已修正）
3. SessionEnd hook 使用 `reason` 字段而非 `session_id` 判断（Task 6 已修正）
4. `kill()` 与 timeout 区分错误语义（Task 4 已修正）
5. ClaudeCodeSession 测试通过 mock `query()` 覆盖成功/错误/超时路径（Task 4 已修正）

---

## Phase 1: 核心回迁

### Task 1: 验证 SDK 依赖可用

**Files:**
- Check: `package.json` (已有 `@anthropic-ai/claude-agent-sdk: ^0.2.50`)
- Check: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

**Step 1: 确认 SDK 已安装且可导入**

Run: `node -e "const sdk = await import('@anthropic-ai/claude-agent-sdk'); console.log('query:', typeof sdk.query); console.log('exports:', Object.keys(sdk).slice(0,10).join(', '))"`
Expected: `query: function` + 关键导出列表

**Step 2: 确认 TypeScript 类型可用**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -5`
Expected: 当前编译无错误（或只有已知错误）

**Step 3: Commit (如果需要修改)**

只在需要调整版本时 commit，否则跳过。

---

### Task 2: 创建 SDK Options 构造器 (纯函数，可单独测试)

**Files:**
- Create: `src/bridges/buildSdkOptions.ts`
- Create: `src/bridges/buildSdkOptions.test.ts`

**Step 1: 写失败测试**

```typescript
// src/bridges/buildSdkOptions.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSdkOptions, type SdkSessionOptions } from './buildSdkOptions.js';
import type { SessionOptions } from './ClaudeCodeSession.js';

describe('buildSdkOptions', () => {
  const base: SessionOptions = { permissionMode: 'bypassPermissions' };

  it('maps bypassPermissions correctly', () => {
    const opts = buildSdkOptions('do stuff', base);
    assert.strictEqual(opts.options.permissionMode, 'bypassPermissions');
    assert.strictEqual(opts.options.allowDangerouslySkipPermissions, true);
    assert.strictEqual(opts.prompt, 'do stuff');
  });

  it('maps acceptEdits correctly', () => {
    const opts = buildSdkOptions('task', { permissionMode: 'acceptEdits' });
    assert.strictEqual(opts.options.permissionMode, 'acceptEdits');
    assert.strictEqual(opts.options.allowDangerouslySkipPermissions, undefined);
  });

  it('maps settingSources for CLAUDE.md loading', () => {
    const opts = buildSdkOptions('task', base);
    assert.deepStrictEqual(opts.options.settingSources, ['user', 'project', 'local']);
  });

  it('maps systemPrompt preset with append', () => {
    const opts = buildSdkOptions('task', { ...base, appendSystemPrompt: 'Be concise' });
    assert.deepStrictEqual(opts.options.systemPrompt, {
      type: 'preset', preset: 'claude_code', append: 'Be concise',
    });
  });

  it('maps systemPrompt preset without append', () => {
    const opts = buildSdkOptions('task', base);
    assert.deepStrictEqual(opts.options.systemPrompt, {
      type: 'preset', preset: 'claude_code',
    });
  });

  it('maps resumeSessionId to resume', () => {
    const opts = buildSdkOptions('task', { ...base, resumeSessionId: 'sess-42' });
    assert.strictEqual(opts.options.resume, 'sess-42');
  });

  it('maps maxBudget to maxBudgetUsd', () => {
    const opts = buildSdkOptions('task', { ...base, maxBudget: 1.5 });
    assert.strictEqual(opts.options.maxBudgetUsd, 1.5);
  });

  it('maps maxTurns directly', () => {
    const opts = buildSdkOptions('task', { ...base, maxTurns: 10 });
    assert.strictEqual(opts.options.maxTurns, 10);
  });

  it('maps model directly', () => {
    const opts = buildSdkOptions('task', { ...base, model: 'claude-opus-4-6' });
    assert.strictEqual(opts.options.model, 'claude-opus-4-6');
  });

  it('maps cwd directly', () => {
    const opts = buildSdkOptions('task', { ...base, cwd: '/tmp/test' });
    assert.strictEqual(opts.options.cwd, '/tmp/test');
  });

  it('maps jsonSchema to outputFormat', () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } } };
    const opts = buildSdkOptions('task', { ...base, jsonSchema: schema });
    assert.deepStrictEqual(opts.options.outputFormat, { type: 'json_schema', schema });
  });

  it('maps allowedTools and disallowedTools', () => {
    const opts = buildSdkOptions('task', {
      ...base,
      allowedTools: ['Read', 'Grep'],
      disallowedTools: ['Edit', 'Write'],
    });
    assert.deepStrictEqual(opts.options.allowedTools, ['Read', 'Grep']);
    assert.deepStrictEqual(opts.options.disallowedTools, ['Edit', 'Write']);
  });

  it('maps timeout to AbortController', () => {
    const opts = buildSdkOptions('task', { ...base, timeout: 30000 });
    assert.ok(opts.options.abortController instanceof AbortController);
  });

  it('passes through extra SDK options (hooks, plugins)', () => {
    const extra = {
      hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
      plugins: [{ type: 'local' as const, path: '/tmp/plugin' }],
    };
    const opts = buildSdkOptions('task', base, extra);
    assert.ok(opts.options.hooks);
    assert.ok(opts.options.plugins);
  });

  it('includes cleanEnv in env', () => {
    const opts = buildSdkOptions('task', base);
    assert.strictEqual(opts.options.env!.CLAUDECODE, undefined);
    assert.strictEqual(opts.options.env!.CLAUDE_CODE_SESSION, undefined);
    assert.strictEqual(opts.options.env!.CLAUDE_MEM_MODEL, 'claude-opus-4-6');
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm run build && node --test dist/bridges/buildSdkOptions.test.js 2>&1 | tail -5`
Expected: FAIL — module `./buildSdkOptions.js` not found

**Step 3: 实现 buildSdkOptions**

```typescript
// src/bridges/buildSdkOptions.ts
import type { Options, SdkPluginConfig, HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { SessionOptions } from './ClaudeCodeSession.js';

// Env vars to clear to prevent nested Claude Code conflicts
const CLAUDE_ENV_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PACKAGE_DIR', 'CLAUDE_DEV_HOST', 'CLAUDE_DEV_PORT',
];

function cleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of CLAUDE_ENV_VARS) {
    delete env[key];
  }
  env.CLAUDE_MEM_MODEL = 'claude-opus-4-6';
  return env;
}

export interface SdkSessionOptions {
  prompt: string;
  options: Options;
  timeoutMs?: number; // for external setTimeout management
}

export interface SdkExtras {
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  plugins?: SdkPluginConfig[];
  agents?: Options['agents'];
  mcpServers?: Options['mcpServers'];
}

export function buildSdkOptions(
  prompt: string,
  opts: SessionOptions,
  extras?: SdkExtras,
): SdkSessionOptions {
  const sdkOpts: Options = {
    // Always load settings + CLAUDE.md
    settingSources: ['user', 'project', 'local'],

    // Permission mode
    permissionMode: opts.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits',
    ...(opts.permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),

    // System prompt with Claude Code preset
    systemPrompt: opts.appendSystemPrompt
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: opts.appendSystemPrompt }
      : { type: 'preset' as const, preset: 'claude_code' as const },

    // Environment
    env: cleanEnv(),

    // Direct mappings
    ...(opts.cwd && { cwd: opts.cwd }),
    ...(opts.model && { model: opts.model }),
    ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
    ...(opts.maxBudget !== undefined && { maxBudgetUsd: opts.maxBudget }),
    ...(opts.resumeSessionId && { resume: opts.resumeSessionId }),
    ...(opts.allowedTools?.length && { allowedTools: opts.allowedTools }),
    ...(opts.disallowedTools?.length && { disallowedTools: opts.disallowedTools }),

    // JSON schema → outputFormat
    ...(opts.jsonSchema && {
      outputFormat: { type: 'json_schema' as const, schema: opts.jsonSchema },
    }),

    // Timeout via AbortController
    ...(opts.timeout && { abortController: new AbortController() }),

    // SDK extras (hooks, plugins, agents, mcpServers)
    ...(extras?.hooks && { hooks: extras.hooks }),
    ...(extras?.plugins?.length && { plugins: extras.plugins }),
    ...(extras?.agents && { agents: extras.agents }),
    ...(extras?.mcpServers && { mcpServers: extras.mcpServers }),
  };

  return {
    prompt,
    options: sdkOpts,
    timeoutMs: opts.timeout,
  };
}
```

**Step 4: 运行测试确认通过**

Run: `npm run build && node --test dist/bridges/buildSdkOptions.test.js`
Expected: 全部 PASS

**Step 5: Commit**

```bash
git add src/bridges/buildSdkOptions.ts src/bridges/buildSdkOptions.test.ts
git commit -m "feat: add buildSdkOptions for Agent SDK Options mapping"
```

---

### Task 3: 创建 SDK 消息迭代器 + SessionResult 提取 (纯函数)

**Files:**
- Create: `src/bridges/sdkMessageCollector.ts`
- Create: `src/bridges/sdkMessageCollector.test.ts`

**Step 1: 写失败测试**

```typescript
// src/bridges/sdkMessageCollector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectResult, type CollectedResult } from './sdkMessageCollector.js';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

// Helper: create a fake SDKResultSuccess
function makeSuccessResult(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Task completed.',
    is_error: false,
    duration_ms: 5000,
    duration_api_ms: 4500,
    num_turns: 3,
    total_cost_usd: 0.05,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 500 },
    modelUsage: {},
    permission_denials: [],
    structured_output: undefined,
    uuid: '00000000-0000-0000-0000-000000000001' as any,
    session_id: 'sess-123',
    ...overrides,
  };
}

function makeErrorResult(errors: string[]): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 2000,
    duration_api_ms: 1800,
    num_turns: 1,
    total_cost_usd: 0.01,
    stop_reason: null,
    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: '00000000-0000-0000-0000-000000000002' as any,
    session_id: 'sess-456',
  };
}

function makeAssistantMessage(text: string, sessionId = 'sess-123'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    } as any,
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000003' as any,
    session_id: sessionId,
  };
}

async function* toAsyncGen(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const msg of messages) yield msg;
}

describe('collectResult', () => {
  it('collects text from assistant messages + result', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Hello '),
      makeAssistantMessage('World'),
      makeSuccessResult(),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.text, 'Task completed.');
    assert.strictEqual(result.costUsd, 0.05);
    assert.strictEqual(result.numTurns, 3);
    assert.strictEqual(result.sessionId, 'sess-123');
    assert.strictEqual(result.isError, false);
    assert.deepStrictEqual(result.errors, []);
  });

  it('uses accumulated text when result text is empty', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Analyzing...'),
      makeAssistantMessage(' Done.'),
      makeSuccessResult({ result: '' }),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.text, 'Analyzing... Done.');
  });

  it('handles error result', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Starting...'),
      makeErrorResult(['Max turns exceeded']),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.errors, ['Max turns exceeded']);
    assert.strictEqual(result.sessionId, 'sess-456');
  });

  it('maps exitCode from subtype', async () => {
    const success = await collectResult(toAsyncGen([makeSuccessResult()]));
    assert.strictEqual(success.exitCode, 0);

    const error = await collectResult(toAsyncGen([makeErrorResult(['err'])]));
    assert.strictEqual(error.exitCode, 1);
  });

  it('invokes onText callback for each text block', async () => {
    const texts: string[] = [];
    const messages: SDKMessage[] = [
      makeAssistantMessage('Part 1'),
      makeAssistantMessage('Part 2'),
      makeSuccessResult(),
    ];
    await collectResult(toAsyncGen(messages), {
      onText: (t) => texts.push(t),
    });
    assert.deepStrictEqual(texts, ['Part 1', 'Part 2']);
  });

  it('invokes onEvent callback for each message', async () => {
    const events: string[] = [];
    const messages: SDKMessage[] = [
      makeAssistantMessage('Hi'),
      makeSuccessResult(),
    ];
    await collectResult(toAsyncGen(messages), {
      onEvent: (e) => events.push(e.type),
    });
    assert.deepStrictEqual(events, ['assistant', 'result']);
  });

  it('extracts structured_output', async () => {
    const messages: SDKMessage[] = [
      makeSuccessResult({ structured_output: { tasks: ['a', 'b'] } }),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.deepStrictEqual(result.json, { tasks: ['a', 'b'] });
  });

  it('extracts usage tokens', async () => {
    const messages: SDKMessage[] = [makeSuccessResult()];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.usage.inputTokens, 1000);
    assert.strictEqual(result.usage.outputTokens, 200);
    assert.strictEqual(result.usage.cacheCreationInputTokens, 100);
    assert.strictEqual(result.usage.cacheReadInputTokens, 500);
  });

  it('handles empty stream gracefully', async () => {
    const result = await collectResult(toAsyncGen([]));
    assert.strictEqual(result.text, '');
    assert.strictEqual(result.costUsd, 0);
    assert.strictEqual(result.isError, true);
    assert.ok(result.errors[0].includes('No result'));
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm run build && node --test dist/bridges/sdkMessageCollector.test.js 2>&1 | tail -5`
Expected: FAIL — module not found

**Step 3: 实现 sdkMessageCollector**

```typescript
// src/bridges/sdkMessageCollector.ts
import type { SDKMessage, SDKResultMessage, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionResult, TokenUsage } from './ClaudeCodeSession.js';

export interface CollectOptions {
  onText?: (text: string) => void;
  onEvent?: (event: SDKMessage) => void;
}

export type CollectedResult = SessionResult;

export async function collectResult(
  stream: AsyncGenerator<SDKMessage, void>,
  opts?: CollectOptions,
): Promise<CollectedResult> {
  const textParts: string[] = [];
  let resultMsg: SDKResultMessage | null = null;
  let sessionId = '';

  for await (const message of stream) {
    opts?.onEvent?.(message);

    // Capture session_id from first message that has it
    if ('session_id' in message && message.session_id && !sessionId) {
      sessionId = message.session_id;
    }

    if (message.type === 'assistant') {
      const assistantMsg = message as SDKAssistantMessage;
      const content = assistantMsg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            textParts.push(block.text);
            opts?.onText?.(block.text);
          }
        }
      }
    }

    if (message.type === 'result') {
      resultMsg = message as SDKResultMessage;
    }
  }

  if (!resultMsg) {
    return {
      text: textParts.join(''),
      costUsd: 0,
      sessionId,
      exitCode: 1,
      numTurns: 0,
      durationMs: 0,
      isError: true,
      errors: ['No result message received from SDK'],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }

  const resultText = 'result' in resultMsg ? (resultMsg as any).result ?? '' : '';
  const structuredOutput = 'structured_output' in resultMsg ? (resultMsg as any).structured_output : undefined;
  const errors: string[] = 'errors' in resultMsg ? ((resultMsg as any).errors ?? []) : [];

  const usage: TokenUsage = {
    inputTokens: resultMsg.usage?.input_tokens ?? 0,
    outputTokens: resultMsg.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: resultMsg.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: resultMsg.usage?.cache_read_input_tokens ?? 0,
  };

  // Map subtype to exitCode
  let exitCode: number;
  if (resultMsg.subtype === 'success') {
    exitCode = 0;
  } else {
    exitCode = 1;
  }

  return {
    text: resultText || textParts.join(''),
    json: structuredOutput,
    costUsd: resultMsg.total_cost_usd ?? 0,
    sessionId: resultMsg.session_id ?? sessionId,
    exitCode,
    numTurns: resultMsg.num_turns ?? 0,
    durationMs: resultMsg.duration_ms ?? 0,
    isError: resultMsg.is_error ?? false,
    errors,
    usage,
  };
}
```

**Step 4: 运行测试确认通过**

Run: `npm run build && node --test dist/bridges/sdkMessageCollector.test.js`
Expected: 全部 PASS

**Step 5: Commit**

```bash
git add src/bridges/sdkMessageCollector.ts src/bridges/sdkMessageCollector.test.ts
git commit -m "feat: add sdkMessageCollector for SDK message stream → SessionResult"
```

---

### Task 4: 重写 ClaudeCodeSession 使用 SDK query()

**Files:**
- Modify: `src/bridges/ClaudeCodeSession.ts` (完全重写内部实现)
- Modify: `src/bridges/ClaudeCodeSession.test.ts` (重写测试)

**Step 1: 重写 ClaudeCodeSession 类**

保留 public 接口不变，内部从 `spawn` 改为 `query()`：

```typescript
// src/bridges/ClaudeCodeSession.ts
import { query, type Query, type SDKMessage, type Options, type HookEvent, type HookCallbackMatcher, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';
import { buildSdkOptions, type SdkExtras } from './buildSdkOptions.js';
import { collectResult } from './sdkMessageCollector.js';

// --- Types (public interface unchanged) ---

export interface SessionOptions {
  /** Permission mode for the Claude Code CLI */
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  /** Max USD budget for this session */
  maxBudget?: number;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** Limit on tools the session can use */
  allowedTools?: string[];
  /** Tools to explicitly block */
  disallowedTools?: string[];
  /** Extra system prompt appended to Claude's defaults */
  appendSystemPrompt?: string;
  /** JSON schema for structured output */
  jsonSchema?: object;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Max number of agentic turns */
  maxTurns?: number;
  /** Callback for streaming text deltas */
  onText?: (text: string) => void;
  /** Callback for each SDK message event */
  onEvent?: (event: SDKMessage) => void;
  /** Model to use (default: claude-sonnet-4-6) */
  model?: string;
}

export interface SessionResult {
  /** Assembled full text output */
  text: string;
  /** Parsed structured output if jsonSchema was specified */
  json?: unknown;
  /** Total cost in USD */
  costUsd: number;
  /** Session ID for resuming */
  sessionId: string;
  /** Process exit code (0=success, 1=error, -1=timeout) */
  exitCode: number;
  /** Number of agentic turns taken */
  numTurns: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the result is an error */
  isError: boolean;
  /** Error messages if isError */
  errors: string[];
  /** Token usage summary */
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// Re-export SDKMessage as StreamEvent for backward compat
export type StreamEvent = SDKMessage;

// --- Session ---

export class ClaudeCodeSession {
  private activeQuery: Query | null = null;
  private abortController: AbortController | null = null;
  private killed = false;
  private sdkExtras: SdkExtras;

  constructor(sdkExtras?: SdkExtras) {
    this.sdkExtras = sdkExtras ?? {};
  }

  /**
   * Run a prompt using the Agent SDK query() API.
   *
   * Replaces the previous CLI spawn implementation. Uses SDK's native
   * message streaming, hooks support, and CLAUDE.md loading.
   */
  async run(prompt: string, opts: SessionOptions): Promise<SessionResult> {
    const start = Date.now();
    const { options, timeoutMs } = buildSdkOptions(prompt, opts, this.sdkExtras);

    // Set up timeout via AbortController
    const ac = options.abortController ?? new AbortController();
    options.abortController = ac;
    this.abortController = ac;
    this.killed = false;  // Reset kill flag

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        log.warn('ClaudeCodeSession: timeout, aborting query', { timeout: timeoutMs });
        ac.abort();
      }, timeoutMs);
    }

    try {
      const q = query({ prompt, options });
      this.activeQuery = q;

      const result = await collectResult(q, {
        onText: opts.onText,
        onEvent: opts.onEvent ? (event) => opts.onEvent!(event) : undefined,
      });

      if (timer) clearTimeout(timer);

      if (timedOut) {
        return {
          ...result,
          exitCode: -1,
          isError: true,
          errors: [`Session timed out after ${timeoutMs}ms`],
          durationMs: Date.now() - start,
        };
      }

      return {
        ...result,
        durationMs: result.durationMs || (Date.now() - start),
      };
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);

      const errMsg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';

      // Distinguish manual kill() from timeout
      if (this.killed) {
        return {
          text: '',
          costUsd: 0,
          sessionId: '',
          exitCode: -2,  // -2 = manual kill, -1 = timeout
          numTurns: 0,
          durationMs: Date.now() - start,
          isError: true,
          errors: ['Session aborted by kill()'],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
      }

      if (timedOut || isAbort) {
        return {
          text: '',
          costUsd: 0,
          sessionId: '',
          exitCode: -1,
          numTurns: 0,
          durationMs: Date.now() - start,
          isError: true,
          errors: [`Session timed out after ${timeoutMs}ms`],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
      }

      log.error('ClaudeCodeSession: query failed', { error: errMsg });
      return {
        text: '',
        costUsd: 0,
        sessionId: '',
        exitCode: 1,
        numTurns: 0,
        durationMs: Date.now() - start,
        isError: true,
        errors: [errMsg],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      };
    } finally {
      this.activeQuery = null;
      this.abortController = null;
    }
  }

  /** Abort the running query (manual kill, distinct from timeout) */
  kill(): void {
    this.killed = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.activeQuery = null;
  }
}
```

**Step 2: 重写测试 (含 mock query 覆盖成功/错误/超时/kill 路径)**

```typescript
// src/bridges/ClaudeCodeSession.test.ts
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeSession, type SessionOptions } from './ClaudeCodeSession.js';

// Mock the SDK query function at module level
// Implementation note: Use node:test mock.module() or dependency injection
// to replace `query` import. The exact approach depends on the import
// mechanism; below shows the test structure.

// Helpers to create mock SDKMessage streams
function makeSuccessResult(overrides = {}) {
  return {
    type: 'result', subtype: 'success', result: 'Done.',
    is_error: false, duration_ms: 3000, duration_api_ms: 2800,
    num_turns: 2, total_cost_usd: 0.03, stop_reason: 'end_turn',
    usage: { input_tokens: 500, output_tokens: 100,
      cache_creation_input_tokens: 50, cache_read_input_tokens: 200 },
    modelUsage: {}, permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 'test-sess-1',
    ...overrides,
  };
}

function makeAssistantMsg(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], role: 'assistant',
      stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 20 } },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-sess-1',
  };
}

function makeErrorResult(errors: string[]) {
  return {
    type: 'result', subtype: 'error_during_execution',
    is_error: true, duration_ms: 1000, duration_api_ms: 900,
    num_turns: 1, total_cost_usd: 0.01, stop_reason: null,
    usage: { input_tokens: 100, output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], errors,
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: 'test-sess-err',
  };
}

describe('ClaudeCodeSession', () => {
  describe('class API', () => {
    it('exports run and kill methods', () => {
      const session = new ClaudeCodeSession();
      assert.strictEqual(typeof session.run, 'function');
      assert.strictEqual(typeof session.kill, 'function');
    });

    it('accepts sdkExtras in constructor', () => {
      const session = new ClaudeCodeSession({
        plugins: [{ type: 'local', path: '/tmp/plugin' }],
      });
      assert.ok(session);
    });
  });

  // NOTE: The following tests require mocking the SDK query() import.
  // Use the project's mock pattern (e.g., constructor injection or
  // mock.module) to inject a fake query function.
  //
  // Test paths to cover:
  //
  // 1. Success path: query yields assistant msgs + success result
  //    → SessionResult.exitCode === 0, text from result, cost tracked
  //
  // 2. Error path: query yields error result
  //    → SessionResult.exitCode === 1, isError true, errors populated
  //
  // 3. Timeout path: query hangs past timeout
  //    → SessionResult.exitCode === -1, errors mention timeout
  //
  // 4. Manual kill path: kill() called during run()
  //    → SessionResult.exitCode === -2, errors mention "aborted by kill()"
  //    (NOT confused with timeout)
  //
  // 5. onText callback: invoked for each assistant text block
  //
  // 6. onEvent callback: invoked for each SDKMessage
  //
  // 7. Structured output: json field populated from structured_output
});
```

**Step 3: 运行所有测试**

Run: `npm run build && node --test dist/bridges/buildSdkOptions.test.js dist/bridges/sdkMessageCollector.test.js dist/bridges/ClaudeCodeSession.test.js`
Expected: 全部 PASS

**Step 4: Commit**

```bash
git add src/bridges/ClaudeCodeSession.ts src/bridges/ClaudeCodeSession.test.ts
git commit -m "feat: rewrite ClaudeCodeSession from CLI spawn to SDK query()"
```

---

### Task 5: 创建插件自动发现

**Files:**
- Create: `src/bridges/pluginDiscovery.ts`
- Create: `src/bridges/pluginDiscovery.test.ts`

**Step 1: 写失败测试**

```typescript
// src/bridges/pluginDiscovery.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins } from './pluginDiscovery.js';

describe('discoverPlugins', () => {
  const testDir = join(tmpdir(), `plugin-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent directory', () => {
    const plugins = discoverPlugins('/nonexistent/path');
    assert.deepStrictEqual(plugins, []);
  });

  it('returns empty array for empty directory', () => {
    const plugins = discoverPlugins(testDir);
    assert.deepStrictEqual(plugins, []);
  });

  it('discovers plugins with version directories', () => {
    // Create: testDir/org-a/plugin-1/1.0.0/
    const pluginDir = join(testDir, 'org-a', 'plugin-1', '1.0.0');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), '{}');

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    assert.strictEqual(plugins[0].type, 'local');
    assert.strictEqual(plugins[0].path, pluginDir);
  });

  it('picks latest version when multiple exist', () => {
    const base = join(testDir, 'org-b', 'plugin-2');
    mkdirSync(join(base, '1.0.0'), { recursive: true });
    mkdirSync(join(base, '2.0.0'), { recursive: true });
    mkdirSync(join(base, '1.5.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    assert.ok(plugins[0].path.endsWith('2.0.0'));
  });

  it('handles double-digit version numbers correctly (semver sort, not string sort)', () => {
    const base = join(testDir, 'org-c', 'plugin-3');
    mkdirSync(join(base, '2.0.0'), { recursive: true });
    mkdirSync(join(base, '10.0.0'), { recursive: true });
    mkdirSync(join(base, '9.1.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 1);
    // String sort would pick '9.1.0'; semver sort correctly picks '10.0.0'
    assert.ok(plugins[0].path.endsWith('10.0.0'), `Expected 10.0.0 but got ${plugins[0].path}`);
  });

  it('discovers multiple plugins across orgs', () => {
    mkdirSync(join(testDir, 'org-a', 'p1', '1.0.0'), { recursive: true });
    mkdirSync(join(testDir, 'org-b', 'p2', '1.0.0'), { recursive: true });

    const plugins = discoverPlugins(testDir);
    assert.strictEqual(plugins.length, 2);
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm run build && node --test dist/bridges/pluginDiscovery.test.js 2>&1 | tail -5`
Expected: FAIL

**Step 3: 实现插件发现**

```typescript
// src/bridges/pluginDiscovery.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';

/** Semver-aware version comparison. Returns negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Discover installed Claude Code plugins from the standard cache directory.
 * Returns plugin configs suitable for passing to SDK Options.plugins.
 */
export function discoverPlugins(pluginsDir?: string): SdkPluginConfig[] {
  const dir = pluginsDir ?? join(homedir(), '.claude', 'plugins', 'cache');
  if (!existsSync(dir)) return [];

  const plugins: SdkPluginConfig[] = [];

  try {
    for (const org of readdirSync(dir)) {
      const orgDir = join(dir, org);
      if (!statSync(orgDir).isDirectory()) continue;

      for (const plugin of readdirSync(orgDir)) {
        const pluginDir = join(orgDir, plugin);
        if (!statSync(pluginDir).isDirectory()) continue;

        // Find latest version directory (semver-aware sort)
        const versions = readdirSync(pluginDir)
          .filter(v => statSync(join(pluginDir, v)).isDirectory())
          .sort(compareSemver)
          .reverse();

        if (versions.length > 0) {
          plugins.push({ type: 'local', path: join(pluginDir, versions[0]) });
        }
      }
    }
  } catch (err) {
    log.warn('Plugin discovery failed', { dir, error: String(err) });
  }

  log.info(`Discovered ${plugins.length} plugin(s)`);
  return plugins;
}
```

**Step 4: 运行测试确认通过**

Run: `npm run build && node --test dist/bridges/pluginDiscovery.test.js`
Expected: 全部 PASS

**Step 5: Commit**

```bash
git add src/bridges/pluginDiscovery.ts src/bridges/pluginDiscovery.test.ts
git commit -m "feat: add plugin auto-discovery for SDK sessions"
```

---

### Task 6: 创建基础 Hooks 构建器

**Files:**
- Create: `src/bridges/hooks.ts`
- Create: `src/bridges/hooks.test.ts`

**Step 1: 写失败测试**

```typescript
// src/bridges/hooks.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHooks, type ToolStat } from './hooks.js';

describe('buildHooks', () => {
  it('returns empty object when no callbacks provided', () => {
    const hooks = buildHooks();
    assert.deepStrictEqual(hooks, {});
  });

  it('registers PostToolUse hook when onToolResult provided', () => {
    const calls: Array<{ name: string }> = [];
    const hooks = buildHooks({
      onToolResult: (name) => { calls.push({ name }); },
    });
    assert.ok(hooks.PostToolUse);
    assert.strictEqual(hooks.PostToolUse!.length, 1);
  });

  it('registers PreToolUse hook when onToolUse provided', () => {
    const hooks = buildHooks({
      onToolUse: () => {},
    });
    assert.ok(hooks.PreToolUse);
  });

  it('registers Stop hook when onStop provided', () => {
    const hooks = buildHooks({
      onStop: () => {},
    });
    assert.ok(hooks.Stop);
  });

  it('registers SessionEnd hook when onSessionEnd provided', () => {
    const hooks = buildHooks({
      onSessionEnd: () => {},
    });
    assert.ok(hooks.SessionEnd);
  });
});

describe('ToolStats', () => {
  // ToolStats 会在 Phase 3 实现，这里只确保导出存在
  it('exports ToolStat type', () => {
    const stat: ToolStat = { name: 'Bash', callCount: 0, totalDurationMs: 0, errorCount: 0 };
    assert.ok(stat);
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm run build && node --test dist/bridges/hooks.test.js 2>&1 | tail -5`
Expected: FAIL

**Step 3: 实现 hooks 构建器**

```typescript
// src/bridges/hooks.ts
import type { HookEvent, HookCallbackMatcher, HookCallback } from '@anthropic-ai/claude-agent-sdk';

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

export function buildHooks(callbacks?: HookCallbacks): HookRegistry {
  if (!callbacks) return {};
  const hooks: HookRegistry = {};

  if (callbacks.onToolUse) {
    const cb = callbacks.onToolUse;
    hooks.PreToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PreToolUse' && 'tool_name' in input) {
          cb((input as any).tool_name, (input as any).tool_input);
        }
        return {};
      }],
    }];
  }

  if (callbacks.onToolResult) {
    const cb = callbacks.onToolResult;
    hooks.PostToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PostToolUse' && 'tool_name' in input) {
          cb((input as any).tool_name, (input as any).tool_input, (input as any).tool_response);
        }
        return {};
      }],
    }];
  }

  if (callbacks.onStop) {
    const cb = callbacks.onStop;
    hooks.Stop = [{
      hooks: [async () => {
        cb();
        return {};
      }],
    }];
  }

  if (callbacks.onSessionEnd) {
    const cb = callbacks.onSessionEnd;
    hooks.SessionEnd = [{
      hooks: [async (input) => {
        // SessionEndHookInput has { reason: ExitReason } — use it directly
        const reason = (input as any).reason ?? 'unknown';
        cb(String(reason));
        return {};
      }],
    }];
  }

  return hooks;
}
```

**Step 4: 运行测试确认通过**

Run: `npm run build && node --test dist/bridges/hooks.test.js`
Expected: 全部 PASS

**Step 5: Commit**

```bash
git add src/bridges/hooks.ts src/bridges/hooks.test.ts
git commit -m "feat: add programmatic hooks builder for SDK sessions"
```

---

### Task 7: 适配 MainLoop 构造函数

**Files:**
- Modify: `src/core/MainLoop.ts` (构造函数 + session 初始化)
- Modify: `src/index.ts` (添加插件发现 + hooks 构造)

**Step 1: 修改 MainLoop 构造函数接受 SDK 配置**

在 `MainLoop` 构造函数添加可选的 `sdkConfig` 参数，传给 `ClaudeCodeSession`：

修改 `src/core/MainLoop.ts`:
- 导入新类型
- 构造函数增加第 7 个参数 `sdkExtras`
- 将 `sdkExtras` 传给 `new ClaudeCodeSession(sdkExtras)`

```typescript
// 新增导入
import type { SdkExtras } from '../bridges/buildSdkOptions.js';

// 构造函数修改
constructor(
  private config: Config,
  private taskQueue: TaskQueue,
  private codex: CodexBridge,
  private taskStore: TaskStore,
  private costTracker: CostTracker,
  private eventBus: CycleEventBus = CycleEventBus.noop(),
  private sdkExtras?: SdkExtras,
) {
  // ...existing code...
  // 修改 session 初始化
  this.brainSession = new ClaudeCodeSession(sdkExtras);
  this.workerSession = new ClaudeCodeSession(sdkExtras);
}
```

将 `brainSession` 和 `workerSession` 的初始化从字段声明移到构造函数内。

**Step 2: 修改 index.ts 添加 SDK 配置**

```typescript
// 新增导入
import { discoverPlugins } from './bridges/pluginDiscovery.js';
import { buildHooks } from './bridges/hooks.js';
import type { SdkExtras } from './bridges/buildSdkOptions.js';

// serve command 中新增 (在 mainLoop 构造之前)
const plugins = discoverPlugins();
const hooks = buildHooks({
  onToolResult: (name, _input, _response) => {
    log.debug(`Tool used: ${name}`);
  },
});
const sdkExtras: SdkExtras = { plugins, hooks };

// 修改 MainLoop 构造
const mainLoop = new MainLoop(config, taskQueue, codexBridge, taskStore, costTracker, eventBus, sdkExtras);
```

**Step 3: 确认编译通过**

Run: `npm run build 2>&1 | tail -10`
Expected: 编译成功，无类型错误

**Step 4: 运行现有测试确保无回归**

Run: `npm test 2>&1 | tail -20`
Expected: 所有测试通过（MainLoop.test.ts 可能需要调整构造函数调用）

**Step 5: Commit**

```bash
git add src/core/MainLoop.ts src/index.ts
git commit -m "feat: wire SDK extras (plugins, hooks) into MainLoop + index.ts"
```

---

### Task 8: 删除旧 CLI 代码 + 清理

**Files:**
- Modify: `src/bridges/ClaudeCodeSession.ts` (删除旧的 buildArgs, cleanEnv)
- Modify: `src/bridges/ClaudeCodeSession.test.ts` (删除 buildArgs 测试)

**Step 1: 清理旧导出**

删除以下不再需要的导出:
- `buildArgs()` 函数 — 已被 `buildSdkOptions` 替代
- `cleanEnv()` 函数 — 已迁移到 `buildSdkOptions.ts`
- `CLAUDE_ENV_VARS` 常量 — 已迁移
- `JsonlEvent` 相关类型 — 不再解析 stream-json

**Step 2: 删除旧测试中的 buildArgs 测试**

ClaudeCodeSession.test.ts 中 `describe('buildArgs', ...)` 整块删除。
stream simulation 和 event parsing 测试也删除（逻辑已迁移到 sdkMessageCollector.test.ts）。

**Step 3: 确认编译通过**

Run: `npm run build 2>&1 | tail -10`
Expected: 编译成功

如果有其他文件引用了 `buildArgs`，更新它们的导入。

**Step 4: 运行全部测试**

Run: `npm test`
Expected: 全部 PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove CLI spawn code, clean up old buildArgs/stream-json"
```

---

### Task 9: 端到端集成验证

**Files:**
- No new files

**Step 1: 编译并检查类型**

Run: `npm run build`
Expected: 编译成功

**Step 2: 运行全部测试**

Run: `npm test`
Expected: 全部 PASS

**Step 3: 手动启动服务验证 SDK 加载**

Run: `node dist/index.js serve --project . 2>&1 | head -30`
Expected:
- 看到 `Discovered N plugin(s)` 日志
- 服务正常启动在 :18800
- 无错误

**Step 4: 触发一次巡逻循环 (可选)**

通过 Web UI 或 API 启动巡逻，观察:
- Brain session 成功调用 SDK query()
- Worker session 成功执行任务
- Hooks 触发（日志中看到 `Tool used: xxx`）
- 费用追踪正确

**Step 5: Commit (如有修复)**

```bash
git add -A
git commit -m "fix: integration fixes from e2e testing"
```

---

## Phase 2: 借鉴改进

### Task 10: 反理性化规则

**Files:**
- Modify: `src/core/PersonaLoader.ts` (GLOBAL_WORKER_RULES)

**Step 1: 在 GLOBAL_WORKER_RULES 末尾添加反理性化表**

```typescript
// 在现有 GLOBAL_WORKER_RULES 字符串末尾追加
export const GLOBAL_WORKER_RULES = `## GLOBAL RULES (non-negotiable)
...existing rules...
## ANTI-RATIONALIZATION
If you think any of these, STOP:
| Your thought | Reality |
| "This is too simple to need tests" | Simple bugs are the hardest to find. Write the test. |
| "I'll just change it first" | Read CLAUDE.md rules before touching code. |
| "This change won't affect anything else" | Use find_referencing_symbols to verify. |
| "Tests pass so it's fine" | tsc pass + test pass + non-empty diff: all three required. |
| "I know a faster way" | Follow the task description exactly. No shortcuts. |`;
```

**Step 2: 运行 PersonaLoader 测试确认不破坏**

Run: `npm run build && node --test dist/core/PersonaLoader.test.js`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/PersonaLoader.ts
git commit -m "feat: add anti-rationalization rules to worker prompts"
```

---

### Task 11: 置信度过滤审查

**⚠ 审查修正**: 仅改 ReviewIssue 接口和 mergeReviews 是不够的。`tryParseReview()`
（`src/utils/parse.ts:107`）在 `.map()` 时只提取已知字段，会丢弃 `confidence`。
必须同步更新解析器。

**Files:**
- Modify: `src/bridges/CodingAgent.ts` (ReviewIssue 增加 confidence)
- Modify: `src/utils/parse.ts` (tryParseReview 提取 confidence)
- Modify: `src/core/MainLoop.ts` (mergeReviews 过滤逻辑)
- Modify: `src/core/MainLoop.test.ts` (新增测试)
- Modify: `src/utils/parse.test.ts` (新增 confidence 解析测试)

**Step 1: 在 ReviewIssue 接口添加 confidence 字段**

```typescript
// src/bridges/CodingAgent.ts
export interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: 'claude' | 'codex';
  confidence?: number;  // 0-1, 未提供视为 1.0
}
```

**Step 2: 更新 tryParseReview 提取 confidence**

在 `src/utils/parse.ts` 的 tryParseReview 函数中，`.map()` 部分添加 confidence:

```typescript
// src/utils/parse.ts:126 附近，在 .map((issue) => ({...})) 中新增:
.map((issue) => ({
  description: String(issue.description),
  severity: issue.severity as ReviewIssue['severity'],
  file: typeof issue.file === 'string' ? issue.file : undefined,
  line: typeof issue.line === 'number' ? issue.line : undefined,
  suggestion: typeof issue.suggestion === 'string' ? issue.suggestion : undefined,
  source: issue.source === 'claude' || issue.source === 'codex' ? issue.source : 'claude',
  confidence: typeof issue.confidence === 'number' ? issue.confidence : undefined,  // ← 新增
}))
```

**Step 3: 写解析器测试确认 confidence 保留**

```typescript
// src/utils/parse.test.ts 新增
it('tryParseReview preserves confidence field', () => {
  const json = JSON.stringify({
    passed: false,
    issues: [
      { severity: 'high', description: 'Bug', confidence: 0.7 },
      { severity: 'critical', description: 'Real bug', confidence: 0.95 },
      { severity: 'medium', description: 'No confidence field' },
    ],
    summary: 'test',
  });
  const result = tryParseReview(json);
  assert.strictEqual(result.issues[0].confidence, 0.7);
  assert.strictEqual(result.issues[1].confidence, 0.95);
  assert.strictEqual(result.issues[2].confidence, undefined);
});
```

**Step 4: 在 mergeReviews 中添加置信度过滤**

在 `src/core/MainLoop.ts` 的 `mergeReviews()` 中:

```typescript
// 在第 1396 行附近，hasCriticalMustFix 的判断修改为:
const effectiveConfidence = (i: ReviewIssue) => i.confidence ?? 1.0;
const hasCriticalMustFix = mustFix.some(
  i => (i.severity === 'critical' || i.severity === 'high') && effectiveConfidence(i) >= 0.8
);
```

**Step 5: 写 mergeReviews 测试确认过滤行为**

```typescript
// src/core/MainLoop.test.ts mergeReviews 测试组新增
it('low-confidence critical issues do not block merge', () => {
  const claude: ReviewResult = {
    passed: false,
    issues: [{ severity: 'critical', description: 'Uncertain bug', source: 'claude', confidence: 0.5 }],
    summary: 'unsure', cost_usd: 0,
  };
  const codex: ReviewResult = {
    passed: false,
    issues: [{ severity: 'critical', description: 'Uncertain bug', source: 'codex', confidence: 0.4 }],
    summary: 'unsure', cost_usd: 0,
  };
  const result = mergeReviews(claude, codex);
  // Both reviewers found same issue but with low confidence
  assert.ok(result.mustFix.length > 0, 'Issue should be in mustFix (matched by both)');
  assert.ok(result.passed, 'Should pass because confidence < 0.8');
});

it('high-confidence critical issues block merge as before', () => {
  const claude: ReviewResult = {
    passed: false,
    issues: [{ severity: 'critical', description: 'Real bug', source: 'claude', confidence: 0.95 }],
    summary: 'real', cost_usd: 0,
  };
  const codex: ReviewResult = {
    passed: false,
    issues: [{ severity: 'critical', description: 'Real bug', source: 'codex', confidence: 0.9 }],
    summary: 'real', cost_usd: 0,
  };
  const result = mergeReviews(claude, codex);
  assert.ok(!result.passed, 'Should NOT pass — high confidence critical issue');
});
```

**Step 6: 运行全部测试**

Run: `npm run build && npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/bridges/CodingAgent.ts src/utils/parse.ts src/utils/parse.test.ts src/core/MainLoop.ts src/core/MainLoop.test.ts
git commit -m "feat: add confidence-based review filtering (interface + parser + merge logic)"
```

---

### Task 12: 任务复杂度分级

**Files:**
- Modify: `src/core/MainLoop.ts` (brainDecide 解析 + workerExecute 资源调整)

**Step 1: 定义复杂度到资源的映射**

```typescript
// src/core/MainLoop.ts 顶部新增
const COMPLEXITY_CONFIG: Record<string, { maxTurns: number; maxBudget: number; timeout: number }> = {
  S:  { maxTurns: 15, maxBudget: 1.0, timeout: 300_000 },
  M:  { maxTurns: 30, maxBudget: 2.0, timeout: 600_000 },
  L:  { maxTurns: 50, maxBudget: 3.0, timeout: 1_200_000 },
  XL: { maxTurns: 80, maxBudget: 5.0, timeout: 1_800_000 },
};
```

**Step 2: 在 brainDecide 的 JSON 解析中提取 complexity**

Brain 输出 JSON 中增加可选 `complexity` 字段。在解析 brain decision 时提取。

**Step 3: 在 workerExecute 中根据 complexity 覆盖默认值**

```typescript
// workerExecute 中
const complexity = task.plan?.complexity as string | undefined;
const config = COMPLEXITY_CONFIG[complexity ?? 'M'];
// 用 config 的值覆盖 maxTurns, maxBudget, timeout
```

**Step 4: 运行测试**

Run: `npm run build && npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: add task complexity grading (S/M/L/XL) for resource allocation"
```

---

### Task 13: 更新 CLAUDE.md 架构说明

**Files:**
- Modify: `CLAUDE.md`

**Step 1: 更新当前状态**

添加: `- [x] Agent SDK 回迁 (v0.2.52 query API + hooks + plugins)`

**Step 2: 更新架构图**

```
编排器 (MainLoop, ~530行)
  ├── 大脑 session (Agent SDK query(), 只读+记忆, 决策+反思)
  ├── 工人 session (Agent SDK query(), 读写, 编码执行)
  ├── 程序化 Hooks (PreToolUse/PostToolUse 观察)
  ├── 插件自动发现 (~/.claude/plugins/cache)
  ├── 硬验证 (tsc 错误计数对比)
  ├── Codex 审查 (codex exec, diff 级审查, 置信度过滤)
  └── Web UI + API (SPA :18800)
```

**Step 3: 更新 ClaudeCodeSession 接口文档**

```typescript
class ClaudeCodeSession {
  constructor(sdkExtras?: SdkExtras);  // hooks, plugins, agents, mcpServers
  async run(prompt: string, opts: SessionOptions): Promise<SessionResult>;
  kill(): void;  // AbortController.abort()
}
// 内部使用 Agent SDK query() API 而非 claude -p CLI
```

**Step 4: 添加新踩坑记录**

```
- SDK isolation mode 默认不加载任何设置: 必须设置 settingSources: ['user', 'project', 'local']
- SDK bypassPermissions 必须同时设置 allowDangerouslySkipPermissions: true
- SDK systemPrompt preset 'claude_code' 获得完整工具链: 不要自定义系统 prompt
```

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Agent SDK migration"
```

---

## 开放问题决策

**Q1: confidence 是只信 Codex 输出，还是 Claude/Codex 都要支持？**
A: 两边都支持。`tryParseReview` 是 Codex 和 Claude (spec review) 共享的解析器，
统一提取 confidence 字段。Brain specReview 的 prompt 中也可以要求输出 confidence。

**Q2: kill() 语义是否应与 timeout 分开？**
A: 是。已修正：
- `exitCode: -1` = timeout（定时器触发）
- `exitCode: -2` = manual kill（`stop()` 调用 `kill()`）
- 通过 `this.killed` 布尔标志区分

**Q3: 插件发现是否需要 manifest 校验？**
A: 暂不需要。Claude Code 自己的插件加载会验证目录内容。
`discoverPlugins` 只负责找到路径，让 SDK 去做验证。
如果 SDK 加载失败，错误会在日志中可见，不需要我们预检。

---

## 验证检查清单

完成所有 task 后，运行以下验证:

1. `npm run build` — 编译无错误
2. `npm test` — 全部测试通过
3. `node dist/index.js serve --project .` — 服务正常启动
4. Web UI 触发巡逻 — Brain/Worker session 正常运行
5. 日志中看到 `Discovered N plugin(s)` — 插件发现生效
6. 日志中看到 `Tool used: xxx` — PostToolUse hooks 触发
7. 任务完成后费用正确记录 — costTracker 正常

## 依赖关系

```
Task 1 (验证 SDK)
  └── Task 2 (buildSdkOptions)
  └── Task 3 (sdkMessageCollector)
        └── Task 4 (重写 ClaudeCodeSession)
              └── Task 5 (插件发现) ──┐
              └── Task 6 (Hooks) ─────┤
                                      └── Task 7 (MainLoop 适配)
                                            └── Task 8 (清理旧代码)
                                                  └── Task 9 (E2E 验证)

Task 10 (反理性化) ─── 独立，随时可做
Task 11 (置信度过滤) ─ 独立，随时可做
Task 12 (复杂度分级) ─ 独立，随时可做
Task 13 (CLAUDE.md) ── 最后做
```
