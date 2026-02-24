# Agent SDK 回迁 + 外部项目借鉴改进设计

日期: 2026-02-24
状态: 待审批

## 背景

db-coder v1 使用 Agent SDK (`@anthropic-ai/claude-agent-sdk`) 的 `query()` API 驱动 Brain/Worker session。因嵌套检测、权限、类型安全、架构复杂度等问题，v2 迁移到 `claude -p --output-format stream-json` CLI 管道模式。

**迁移后发现关键缺陷**: `claude -p` 管道模式下，只有 `SessionStart` hooks 触发，`PreToolUse`/`PostToolUse`/`Stop`/`SessionEnd` **完全不触发**。这意味着:
- claude-mem 的 PostToolUse 观察捕获对 worker/brain session 无效
- ECC 的代码质量 hooks (auto-format, typecheck) 对 worker 无效
- 所有基于 hooks 的插件对自主 session 都是"死的"

Agent SDK v0.2.52 现已支持原生程序化 hooks (18 种事件类型的 TypeScript 回调)，解决了 v1 时代的所有已知问题。

## 目标

1. 回迁到 Agent SDK `query()` API，获得完整 hooks 支持
2. 复现 `claude -p` CLI 的开箱即用能力 (CLAUDE.md 加载、插件发现、完整系统 prompt)
3. 利用 SDK 独有能力: in-process MCP server、动态控制、file checkpointing
4. 保持 v2 的简洁架构 (brain+worker 模式、~530 行 MainLoop)，不重蹈 v1 复杂度覆辙

## 非目标

- 不恢复 v1 的 Brain.ts/EvolutionEngine/PromptRegistry/PlanWorkflow 等已删除模块
- 不重写 MainLoop 核心循环逻辑 (brainDecide → workerExecute → hardVerify → codexReview → brainReflect)
- 不改变 Codex 审查流程

## 方案

### 1. ClaudeCodeSession 重写为 SDK Wrapper

将 `ClaudeCodeSession` 从 CLI 子进程管理改为 Agent SDK `query()` 调用。

**当前接口保持不变**:
```typescript
class ClaudeCodeSession {
  async run(prompt: string, opts: SessionOptions): Promise<SessionResult>;
  kill(): void;
}
```

**内部实现变化**:
- 删除: `buildArgs()`, `spawn('claude', ...)`, stream-json 行解析, SIGTERM/SIGKILL 超时处理
- 新增: `query()` 调用, `AbortController` 超时, `SDKMessage` 迭代, Options 构造

**Options 映射**:

| SessionOptions 字段 | SDK Options 字段 |
|---|---|
| `permissionMode` | `permissionMode` + `allowDangerouslySkipPermissions: true` |
| `maxBudget` | `maxBudgetUsd` |
| `resumeSessionId` | `resume` |
| `allowedTools` | `allowedTools` |
| `disallowedTools` | `disallowedTools` |
| `appendSystemPrompt` | `systemPrompt: { preset: 'claude_code', append }` |
| `jsonSchema` | `outputFormat: { type: 'json_schema', schema }` |
| `cwd` | `cwd` |
| `timeout` | `abortController` + `setTimeout` |
| `maxTurns` | `maxTurns` |
| `model` | `model` |
| `onText` | 从 `SDKAssistantMessage.message.content` 提取 |
| `onEvent` | 直接转发 `SDKMessage` |

**新增 Options 字段**:

| 字段 | 用途 |
|---|---|
| `hooks` | 传入程序化 hooks |
| `plugins` | 传入自动发现的插件列表 |
| `mcpServers` | 传入 in-process MCP server |
| `agents` | 传入 subagent 定义 |

**SessionResult 映射**:

| SessionResult 字段 | SDK 来源 |
|---|---|
| `text` | `SDKResultMessage.result` |
| `json` | `SDKResultMessage.structured_output` |
| `costUsd` | `SDKResultMessage.total_cost_usd` |
| `sessionId` | `SDKResultMessage.session_id` |
| `exitCode` | 根据 `subtype` 映射: success→0, error→1, timeout→-1 |
| `numTurns` | `SDKResultMessage.num_turns` |
| `durationMs` | `SDKResultMessage.duration_ms` |
| `isError` | `SDKResultMessage.is_error` |
| `errors` | `SDKResultMessage.errors` (error subtypes) |
| `usage` | `SDKResultMessage.usage` |

### 2. 复现 CLI 开箱即用能力

#### 2a. 设置和 CLAUDE.md 加载

```typescript
settingSources: ['user', 'project', 'local']
```

一行配置，加载:
- `~/.claude/settings.json` (用户设置，包含 hooks 定义)
- `.claude/settings.json` (项目设置)
- `.claude/settings.local.json` (本地设置)
- `CLAUDE.md` (项目上下文)
- `~/.claude/CLAUDE.md` (用户全局上下文)

#### 2b. 完整系统 Prompt

```typescript
systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt }
```

使用 Claude Code 内置的完整系统 prompt，加上我们的 append 内容 (persona prompt、brain/worker 角色说明)。

#### 2c. 插件自动发现

新增 `src/bridges/pluginDiscovery.ts` (~50 行):

```typescript
export function discoverPlugins(pluginsDir?: string): SdkPluginConfig[] {
  const dir = pluginsDir ?? join(homedir(), '.claude/plugins/cache');
  if (!existsSync(dir)) return [];

  const plugins: SdkPluginConfig[] = [];
  for (const org of readdirSync(dir)) {
    const orgDir = join(dir, org);
    for (const plugin of readdirSync(orgDir)) {
      const pluginDir = join(orgDir, plugin);
      // 找到最新版本目录
      const versions = readdirSync(pluginDir).sort().reverse();
      if (versions.length > 0) {
        plugins.push({ type: 'local', path: join(pluginDir, versions[0]) });
      }
    }
  }
  return plugins;
}
```

在 MainLoop 初始化时调用一次，缓存结果，传给所有 session。

#### 2d. 环境变量清除

保留现有 `cleanEnv()` 逻辑，通过 `env` 选项传入:

```typescript
env: cleanEnv()
```

### 3. 程序化 Hooks

新增 `src/bridges/hooks.ts` (~100 行):

```typescript
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export type HookRegistry = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export function buildHooks(options?: {
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, input: unknown, response: unknown) => void;
  onSessionEnd?: (reason: string) => void;
  onStop?: () => void;
}): HookRegistry {
  const hooks: HookRegistry = {};

  if (options?.onToolUse) {
    hooks.PreToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PreToolUse') {
          options.onToolUse!(input.tool_name, input.tool_input);
        }
        return {};
      }],
    }];
  }

  if (options?.onToolResult) {
    hooks.PostToolUse = [{
      hooks: [async (input) => {
        if (input.hook_event_name === 'PostToolUse') {
          options.onToolResult!(input.tool_name, input.tool_input, input.tool_response);
        }
        return {};
      }],
    }];
  }

  // SessionEnd, Stop 等类似
  return hooks;
}
```

**初期保持简单**: 只注册观察性 hooks (不修改 tool input/output)，用于:
- 记录 tool 使用统计 (哪些 tool 用得多、耗时多久)
- 触发 claude-mem 记忆捕获
- Worker session 的代码质量观察

**后期扩展**: PreToolUse 拦截 (安全审查)、PostToolUse 自动修复 (格式化、类型检查)。

### 4. In-Process MCP Server (可选，Phase 2)

新增 `src/bridges/systemMcp.ts` (~80 行):

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function createSystemMcpServer(taskStore, costTracker) {
  return createSdkMcpServer({
    name: 'db-coder-system',
    tools: [
      tool('get_pending_tasks', 'Get queued tasks', { limit: z.number().optional() },
        async ({ limit }) => ({
          content: [{ type: 'text', text: JSON.stringify(await taskStore.getQueued(limit)) }]
        })
      ),
      tool('get_daily_cost', 'Get today cost summary', {},
        async () => ({
          content: [{ type: 'text', text: JSON.stringify(await costTracker.getSummary()) }]
        })
      ),
      tool('get_recent_logs', 'Get recent task logs', { taskId: z.string() },
        async ({ taskId }) => ({
          content: [{ type: 'text', text: JSON.stringify(await taskStore.getTaskLogs(taskId)) }]
        })
      ),
    ]
  });
}
```

Brain session 可直接通过 MCP tool 查询系统状态，无需在 prompt 中硬编码。

### 5. MainLoop 适配

MainLoop 的 7 个 session 调用点 (brainThink, workerExecute, workerFix, brainReflect, deepChainReview, claudeMdMaintenance, PlanChatManager) 的**调用方式不变**——`ClaudeCodeSession.run(prompt, opts)` 接口保持一致。

变化在 MainLoop 初始化:

```typescript
// index.ts 新增
const plugins = discoverPlugins();
const hooks = buildHooks({ onToolResult: (name, input, resp) => { /* 统计 */ } });
const systemMcp = createSystemMcpServer(taskStore, costTracker);

// 传给 MainLoop 构造函数 (新增第 6 个参数)
const mainLoop = new MainLoop(config, taskQueue, codex, taskStore, costTracker, {
  plugins,
  hooks,
  systemMcpServer: systemMcp,
});
```

MainLoop 将这些配置透传给 ClaudeCodeSession。

## 文件变更清单

| 文件 | 操作 | 行数估计 |
|---|---|---|
| `src/bridges/ClaudeCodeSession.ts` | 重写 | ~250 行 (现 339 行) |
| `src/bridges/ClaudeCodeSession.test.ts` | 重写测试 | ~200 行 |
| `src/bridges/pluginDiscovery.ts` | 新建 | ~50 行 |
| `src/bridges/hooks.ts` | 新建 | ~100 行 |
| `src/bridges/systemMcp.ts` | 新建 (Phase 2) | ~80 行 |
| `src/core/MainLoop.ts` | 修改构造函数 + 透传配置 | ~30 行改动 |
| `src/core/PlanChatManager.ts` | 微调 (如果接口不变则零改动) | ~10 行 |
| `src/index.ts` | 添加初始化逻辑 | ~20 行 |
| `package.json` | 添加 SDK 依赖 | 2 行 |
| `tsconfig.json` | 可能需要调整 (zod peer dep) | 视情况 |

**Phase 1 总计**: ~740 行新代码/重写，~30 行改动，删除 ~339 行旧代码。净增约 400 行。
**Phase 2 总计**: ~105 行改动 (反理性化 15 + 置信度 20 + 复杂度 30 + subtask 隔离 40)。
**Phase 3 总计**: ~160 行新代码 (MCP 80 + subagent 20 + checkpointing 30 + 观察聚合 30)。

## 6. 借鉴外部项目的改进 (来自 BMAD/ECC/Superpowers 分析)

SDK 回迁为以下改进提供了基础设施（hooks + in-process MCP），使其成为可能。

### 6a. 反理性化规则 (借鉴 Superpowers)

在 `PersonaLoader.GLOBAL_WORKER_RULES` 中添加反理性化表:

```
ANTI-RATIONALIZATION:
| 你的想法 | 现实 |
| "这太简单不需要测试" | 简单的东西出 bug 最隐蔽。写测试。 |
| "我先改了再说" | 先读 CLAUDE.md 规则再动手。 |
| "这个改动不影响其他地方" | 用 find_referencing_symbols 验证。 |
| "测试通过就行了" | tsc 通过 + test 通过 + diff 非空 三条件都要满足。 |
```

**改动位置**: `src/core/PersonaLoader.ts` GLOBAL_WORKER_RULES 数组
**工作量**: ~15 行

### 6b. 置信度过滤审查 (借鉴 ECC code-reviewer)

Codex 和 Brain 审查输出增加 `confidence` 字段 (0-1):

```typescript
interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: 'claude' | 'codex';
  confidence?: number;  // 新增
}
```

`mergeReviews()` 过滤逻辑:
- `confidence >= 0.8` → 保留为 mustFix/shouldFix
- `confidence < 0.8` → 降级为信息性，不阻止合并
- 未提供 confidence → 视为 1.0 (向后兼容)

**改动位置**: `src/bridges/CodingAgent.ts` (接口), `src/core/MainLoop.ts` mergeReviews()
**工作量**: ~20 行

### 6c. 任务复杂度分级 (借鉴 BMAD)

Brain 决策输出增加 `complexity` 字段:

```typescript
interface BrainDecision {
  task: string;
  persona?: string;
  taskType?: string;
  subtasks?: SubTask[];
  complexity?: 'S' | 'M' | 'L' | 'XL';  // 新增
}
```

根据复杂度自动调整资源:

| 复杂度 | maxTurns | maxBudget | timeout | 拆分 subtask |
|---|---|---|---|---|
| S | 15 | $1.0 | 5min | 不拆 |
| M | 30 | $2.0 | 10min | 可选 |
| L | 50 | $3.0 | 20min | 建议拆 |
| XL | 80 | $5.0 | 30min | 必须拆 |

**改动位置**: `src/core/MainLoop.ts` workerExecute()
**工作量**: ~30 行

### 6d. Subtask Session 隔离 (借鉴 Superpowers dispatching-parallel-agents)

当前所有 subtask 共享同一个 worker session (via resumeSessionId)。改为每个 subtask 独立 session:

- 防止一个 subtask 的错误上下文污染后续 subtask
- 每个 subtask 独立 hardVerify + git commit
- 失败的 subtask 可以安全重试而不影响已完成的

**改动位置**: `src/core/MainLoop.ts` executeSubtasks()
**工作量**: ~40 行 (主要是删除 sessionId 传递逻辑)

### 6e. PostToolUse 观察捕获 (借鉴 claude-mem + ECC Continuous Learning)

通过 SDK hooks，在每次 tool 使用后捕获观察:

```typescript
PostToolUse: [{
  hooks: [async (input) => {
    if (input.hook_event_name === 'PostToolUse') {
      // 记录到内存中的统计聚合器
      toolStats.record(input.tool_name, input.tool_input, input.tool_response);
    }
    return {};
  }]
}]
```

Brain reflect 时将聚合的 tool 使用统计写入 claude-mem，形成经验积累。

**改动位置**: `src/bridges/hooks.ts`
**工作量**: ~30 行

### 6f. 前置审查/后置审查 (借鉴 BMAD 对抗性审查)

利用 SDK 的 `agents` 定义，添加专门的审查 subagent:

```typescript
agents: {
  'pre-mortem-reviewer': {
    description: 'Pre-mortem analysis before executing a task',
    prompt: 'Assume this task WILL fail. List the 3 most likely failure modes...',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 5,
  }
}
```

Brain 在决策后可以自动调用 pre-mortem-reviewer subagent 进行前瞻性分析。

**改动位置**: MainLoop 初始化时传入 agents 定义
**工作量**: ~20 行配置

## 分阶段实施

### Phase 1: 核心回迁 (必须)
1. 安装 SDK 依赖 + zod
2. 重写 ClaudeCodeSession 为 SDK wrapper
3. 实现插件自动发现
4. 实现基础 hooks (观察性 PostToolUse)
5. 适配 MainLoop 和 index.ts
6. 重写测试
7. 端到端验证 (patrol 模式运行)

### Phase 2: 借鉴改进 (推荐)
8. 反理性化规则 (PersonaLoader)
9. 置信度过滤审查 (mergeReviews)
10. 任务复杂度分级 (brainDecide + workerExecute)
11. Subtask session 隔离 (executeSubtasks)

### Phase 3: 高级能力 (可选)
12. In-process MCP server (系统数据工具)
13. Subagent 定义 (pre-mortem-reviewer 等)
14. File checkpointing (workerFix 回滚)
15. PreToolUse 拦截 hooks (安全/质量门禁)
16. PostToolUse 观察聚合 → claude-mem 经验积累

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SDK `settingSources` 不加载 shell hooks | hooks 插件仍不生效 | 实测验证；不行则在程序化 hooks 中手动调用 shell 命令 |
| SDK 版本升级 breaking change | 构建失败 | 锁定版本 `0.2.52`，关注 changelog |
| 插件发现路径变化 | 插件不加载 | 增加日志，失败时 warn 而非 crash |
| `bypassPermissions` 传播给 subagent | 安全风险 | 这是预期行为，worker 需要完全自主 |
| zod v4 peer dep 与现有 zod 冲突 | 安装失败 | 仅在 systemMcp.ts 中使用 zod，Phase 2 才需要 |

## 决策记录

- **ADR-001**: 选择 SDK `query()` 而非 `unstable_v2_createSession()`。V2 接口缺少 `settingSources`、`systemPrompt`、`agents`、`plugins`、`mcpServers`，功能不完整。
- **ADR-002**: 保留 `ClaudeCodeSession` 接口不变。降低迁移风险，MainLoop 调用点无需改动。
- **ADR-003**: 插件发现在启动时一次性执行并缓存。运行中安装的插件需重启才生效，可接受。
- **ADR-004**: 使用 `systemPrompt: { preset: 'claude_code' }` 而非自定义系统 prompt。获得 Claude Code 的完整工具链能力，通过 `append` 注入定制内容。
