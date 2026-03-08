# db-coder: 自主 AI 编码 Agent (v2)

## 愿景

一个能长时间自主运行的编码 agent，通过分阶段 runtime 编排（brain / plan / execute / review / reflect / scan）主动发现问题、制定计划、执行改进、审查结果并积累经验。以 systemd 服务部署在 24 小时工作站上，通过 Web UI 随时交互。

## 核心决策

| 决策项 | 选择 |
|--------|------|
| 语言 | TypeScript (ESM) |
| 大脑 | `routing.brain` 指定 runtime + model（默认 `claude-sdk`） |
| 工人 | `routing.execute` 指定 runtime + model |
| 审查 | `routing.review` 指定 runtime + model（默认与 execute 使用不同组合） |
| 硬验证 | tsc 错误计数对比基线 |
| 经验积累 | `CLAUDE.md` + `claude-mem` |
| 任务存储 | PostgreSQL |
| 自主级别 | 完全自主（Git 分支隔离） |
| 运行模式 | systemd 服务 + Web UI |
| Git 策略 | `db-coder/*` 分支隔离 |

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                db-coder 服务 (systemd, 24h 运行)              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Main Loop 编排器                                       │  │
│  │ brainDecide → [analyze M/L/XL] → workerExecute         │  │
│  │ → hardVerify → codeReview → brainDecision → merge      │  │
│  └────────────────────────────────────────────────────────┘  │
│            │                     │                    │      │
│            ▼                     ▼                    ▼      │
│  ┌─────────────────┐   ┌─────────────────┐  ┌─────────────┐ │
│  │ 决策类 runtime   │   │ 执行 runtime     │  │ 审查 runtime │ │
│  │ brain/plan/      │   │ execute/fix/     │  │ reviewPlan/ │ │
│  │ reflect/scan     │   │ analyze          │  │ codeReview  │ │
│  │ RuntimeAdapter   │   │ RuntimeAdapter   │  │ ReviewAdapter│ │
│  └─────────────────┘   └─────────────────┘  └─────────────┘ │
│                                                              │
│  ┌───────────────┐   ┌────────────────────┐                  │
│  │ HTTP Server   │   │ CLAUDE.md +        │                  │
│  │ :18801        │   │ claude-mem         │                  │
│  │ API + Web UI  │   │ (上下文/经验)       │                  │
│  └───────────────┘   └────────────────────┘                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ PostgreSQL: tasks / task_logs / plan_drafts / costs    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 分阶段 Runtime 架构

### 决策类阶段 (`brain` / `plan` / `reflect` / `scan`)

- 统一经 `RuntimeAdapter` 调用，默认走 Claude SDK，但可由 `routing.*` 独立指定 runtime + model
- 主要负责任务决策、方案汇总、审查裁决、执行后反思、链路扫描
- 默认以只读方式运行，依靠 `readOnly` / `disallowedTools` 约束修改能力
- 结构化输出优先通过 `outputSchema` 提取，必要时回退到文本解析

### 执行阶段 (`execute`)

- 由 `WorkerPhase` 驱动，底层直接调用 `RuntimeAdapter.run()`
- 默认模型来源于 `routing.execute.model`，也允许大脑通过 `resource_request.model` 申请覆盖
- 当大脑输出 `directive` 时，执行阶段采用 **directive 直通**：以 `directive` 为主 prompt，仅补充通用规则，不再经 PersonaLoader 重组
- `resource_request` 采用 request + cap 机制：预算 / 超时 / 模型申请由大脑提出，编排器负责上限约束

### 审查阶段 (`review`)

- 由 `ReviewPhase` 驱动，底层通过 `RuntimeReviewAdapter` 调用 review runtime
- 审查 runtime 由 `routing.review` 决定，默认建议与 `execute` 使用不同 runtime + model 组合，降低自我验证偏差
- 适用于方案审查 (`reviewPlan`) 和代码审查 (`codeReview`)

### 兼容说明

- `autonomy.worker` 已废弃，仅为配置兼容保留；运行时以 `routing.execute` / `routing.review` 为准
- `WorkerAdapter.ts` 当前主要保留共享类型与 `RuntimeReviewAdapter`，旧的 Claude/Codex worker 实现已移除

## 自主运行循环

```
brainDecide (brain runtime, 默认只读)
  - 读取最小上下文（队列 / 最近任务 / 预算 / 健康指标）
  - 需要更多信息时，自行通过工具补充检索
  - 输出: `summary(task_description)` + `directive` + `resource_request` + `verification_plan`
  ▼
[方案阶段] (仅 M/L/XL 任务, S 任务跳过)
  - workerAnalyze: execute runtime 只读分析代码，输出具体变更方案
  - reviewPlan: review runtime 审查方案
  - brainSynthesizePlan: plan runtime 汇总批准 / 驳回 / 要求修订
  - 否决 → 任务 blocked
  ▼
workerExecute (execute runtime, 读写)
  - 在 Git 分支 `db-coder/<task-id>` 上执行
  - 若存在 `directive`，则以 directive 为主 prompt 直通执行
  - `resource_request` 申请预算 / 超时 / 可选模型，编排器做 cap
  ▼
hardVerify (shell: tsc)
  - 对比 tsc 错误计数：执行后 vs 基线
  - 新增错误 → workerFix（优先复用同一 runtime / session）
  - 检查 git diff 是否有实际变更
  ▼
codeReview (review runtime)
  - 按 `routing.review` 选择 runtime + model
  - 默认建议与 execute 使用不同组合，但不是硬性强制
  - 审查 git diff，返回 `ReviewResult`
  ▼
brainReviewDecision (brain runtime)
  - fix / ignore / block / rewrite / split
  - 修复轮次由 `maxReviewFixes` 控制
  ▼
brainReflect (reflect runtime, 只读)
  - 输出 `reflection / strategy_update / retrieval_lesson`
  - 写入 `task_logs.details`
  - 将 lesson 保存到 `claude-mem`
  ▼
mergeBranch (决策允许时)
  - 合并到 main，清理分支
  - split 时同时创建后续任务入队
  - 继续下一个任务

[周期性维护]
  - `claudeMdMaintenance` 独立运行，负责校验并更新 `CLAUDE.md`
```

## 记忆与进化

### CLAUDE.md (项目根目录)

Claude runtime 的共享上下文，Claude SDK 启动时自动读取。内容包括:

- 项目架构和当前状态
- 待办优先级
- 环境规则（构建命令、DB 连接等）
- DB Schema
- 功能链路定义（ChainScanner 自动推导补充）
- 踩过的坑（经验教训）

当前实现中，`CLAUDE.md` 的维护主要由周期性 `claudeMdMaintenance` 完成，而不是在 `brainReflect` 中直接编辑。

### claude-mem (语义搜索)

项目级经验记忆，通过 HTTP API (`:37777`) 访问。当前实现中，反思阶段会写入 lesson；决策阶段默认只拿最小上下文，需要更多经验时由大脑自行触发检索。

### 设计原则

- 不使用数值化进化评分 (v1 的 adjustments 证明无效)
- 不自建记忆系统 (v1 三套记忆互不通信)
- 不写 prompt 模板 (v1 的 1431 行模板限制 Claude 能力)
- 进化 = CLAUDE.md 自然更新 + claude-mem 语义积累

## 数据存储

### PostgreSQL (活跃表)

```sql
-- 任务记录
tasks: id(uuid), project_path, task_description, phase, priority(0-3),
       plan(jsonb), subtasks(jsonb), review_results(jsonb), iteration,
       total_cost_usd, git_branch, start_commit, depends_on(uuid[]), status,
       directive(text), strategy_note(text), verification_plan(text),
       resource_request(jsonb), evaluation_score(jsonb),
       evaluation_reasoning(text), created_at, updated_at

-- 执行日志
task_logs: id(serial), task_id(fk), phase, agent, input_summary,
           output_summary, cost_usd, duration_ms, details(jsonb), created_at

-- 每日费用
daily_costs: date(pk), total_cost_usd, task_count

-- 链路扫描状态
chain_scan_state: project_path(pk), next_index, entry_points(jsonb),
                  known_fingerprints(jsonb), last_discovery_at,
                  last_scan_at, scan_count, updated_at

-- 计划草案
plan_drafts: id(serial), project_path, plan(jsonb), analysis_summary,
             reasoning, markdown, status, annotations(jsonb), scan_id,
             chat_session_id, chat_status, cost_usd, created_at, reviewed_at

-- 计划对话消息
plan_chat_messages: id(serial), session_id, role, content,
                    metadata(jsonb), created_at
```

### 停用表 (不删除，停止写入)

adjustments, memories, scan_modules, scan_results, evaluation_events,
review_events, goal_progress, prompt_versions, config_proposals

## 服务端架构

### HTTP Server (:18801)

同一服务同时提供 REST API 和 Web UI:

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态 |
| GET | `/api/status/stream` | SSE 实时状态 |
| GET | `/api/metrics` | 运营指标 |
| GET/POST | `/api/tasks` | 任务列表/创建 |
| GET | `/api/tasks/:id` | 任务详情 |
| GET | `/api/tasks/pending-review` | 待审查任务 |
| POST | `/api/tasks/:id/approve` | 批准任务 |
| POST | `/api/tasks/:id/skip` | 跳过任务 |
| POST | `/api/control/pause\|resume\|scan` | 循环控制 |
| POST | `/api/patrol/start\|stop` | 巡逻启停 |
| GET | `/api/logs?follow=true` | SSE 日志流 |
| GET | `/api/cost` | 费用数据 |
| GET | `/api/cycle/metrics` | 循环性能指标 |
| GET | `/api/cycle/entries` | 循环历史记录 |
| GET | `/api/personas` | Persona 列表 |
| PUT | `/api/personas/:name` | 更新 Persona 内容 |
| GET | `/api/plans` | 计划列表 |
| POST | `/api/plans/:id/approve\|reject\|execute` | 计划操作 |

使用 Node.js 内置 `http` 模块，Bearer Token 认证，CSP 安全头。

### Web UI

纯前端 SPA (HTML/CSS/JS)，零构建依赖:

- **仪表盘** — 系统状态、巡逻控制、快捷操作
- **巡逻模式** — 顶栏按钮启停，实时状态显示
- **任务列表** — 查看、筛选、管理任务
- **运行日志** — SSE 实时日志流，级别过滤
- **费用追踪** — 每日费用统计

## 安全保障

1. Git 分支隔离 (不动 main/master)
2. 预算上限 (单任务/每日)
3. 项目目录内操作
4. Bearer Token 认证
5. CSP 安全头 + 请求体大小限制 + 速率限制
6. 硬验证阻止合并劣化代码

## 目录结构

```
src/
├── index.ts                         # CLI 入口 (commander)
├── core/
│   ├── MainLoop.ts                  # 核心编排循环
│   ├── MainLoop.test.ts             # 主循环测试
│   ├── WorkerAdapter.ts             # WorkerResult + ReviewAdapter + RuntimeReviewAdapter
│   ├── ChainScanner.ts              # 链路扫描器（自动入口发现 + 边界验证）
│   ├── chain-scanner-types.ts       # ChainScanner 类型定义
│   ├── PersonaLoader.ts             # Persona 加载 + 通用 worker 规则包装
│   ├── CycleEventBus.ts             # 类型化事件总线（循环生命周期）
│   ├── CycleEvents.ts               # 循环事件类型定义
│   ├── ModeManager.ts               # PatrolManager（巡逻启停）
│   ├── PlanChatManager.ts           # 计划对话管理
│   ├── TaskQueue.ts                 # 任务队列（从 DB 获取 queued 任务）
│   ├── Shutdown.ts                  # 优雅退出
│   ├── types.ts                     # 核心类型
│   ├── phases/                      # Phase 拆分后的主流程
│   │   ├── BrainPhase.ts            # 任务决策 / 反思 / 方案汇总
│   │   ├── WorkerPhase.ts           # 执行 / 修复 / 分析
│   │   ├── ReviewPhase.ts           # 方案审查 / 代码审查
│   │   ├── MaintenancePhase.ts      # 硬验证 / CLAUDE.md 维护 / 清理
│   │   └── brainThink.ts            # 决策类 runtime 调用包装
│   ├── guards/                      # 执行前验证
│   │   ├── BudgetGuard.ts           # 预算超限检查
│   │   ├── ConcurrencyGuard.ts      # 并发控制
│   │   ├── EmptyDiffGuard.ts        # 空 diff 检测
│   │   ├── StructuredOutputGuard.ts # 结构化输出验证
│   │   └── WorkerFixResultGuard.ts  # Worker 修复结果检查
│   ├── observers/                   # 循环事件观察者
│   │   ├── CycleMetricsCollector.ts # 循环性能指标收集
│   │   ├── NotificationObserver.ts  # 通知推送
│   │   ├── StructuredCycleLogger.ts # 结构化日志
│   │   └── WebUIRealtimeObserver.ts # Web UI 实时更新
│   └── strategies/                  # 决策策略
│       ├── DynamicPriorityStrategy.ts # 动态优先级
│       ├── FailureLearningStrategy.ts # 失败学习
│       └── TaskQualityEvaluator.ts    # 任务质量评估
├── runtime/
│   ├── RuntimeAdapter.ts           # 统一 runtime 接口
│   ├── ClaudeSdkRuntime.ts         # Claude SDK runtime
│   ├── CodexSdkRuntime.ts          # Codex SDK runtime
│   ├── CodexCliRuntime.ts          # Codex CLI runtime
│   └── runtimeFactory.ts           # runtime 注册 / alias / fallback
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Agent SDK query() 封装
│   ├── ReviewTypes.ts              # ReviewResult / ReviewIssue 类型
│   ├── sdkMessageCollector.ts       # SDK 流事件收集 + 错误合成
│   ├── buildSdkOptions.ts           # SDK 选项构建器
│   ├── hooks.ts                     # 程序化 PreToolUse/PostToolUse hooks
│   ├── pluginDiscovery.ts           # 自动发现 ~/.claude/plugins/cache 插件
│   └── CodexBridge.ts               # Codex CLI 子进程封装（供 codex-cli runtime 复用）
├── memory/
│   ├── TaskStore.ts                 # PostgreSQL: 任务/日志/费用/计划/personas
│   ├── GlobalMemory.ts              # PostgreSQL: 全局记忆 (逐步淡出)
│   ├── ProjectMemory.ts             # claude-mem HTTP 客户端
│   ├── schemas.ts                   # DB 表创建 (DDL)
│   └── types.ts                     # 记忆类型
├── server/
│   ├── Server.ts                    # HTTP 服务 (API + 静态文件 + 安全头)
│   ├── routes.ts                    # REST API 路由 (~900行)
│   └── rateLimit.ts                 # 速率限制
├── config/
│   ├── Config.ts                    # 配置加载 (全局 + 项目级)
│   └── types.ts                     # 配置类型
├── utils/
│   ├── git.ts                       # Git 操作 (分支/提交/合并/diff)
│   ├── cost.ts                      # CostTracker (预算守卫)
│   ├── process.ts                   # 子进程工具
│   ├── safeBuild.ts                 # 原子 dist/ 替换 (自修改安全)
│   ├── logger.ts                    # 日志
│   ├── parse.ts                     # JSON 解析 + review 结构验证 + Markdown 回退解析
│   ├── validateConfig.ts            # 配置校验 (启动时)
│   ├── similarity.ts                # 文本相似度 (审查交叉匹配)
│   └── retry.ts                     # 重试工具
├── evolution/
│   ├── TrendAnalyzer.ts             # 健康趋势分析
│   └── types.ts                     # 进化类型
├── mcp/
│   └── McpDiscovery.ts              # MCP 插件发现
├── prompts/
│   ├── PromptRegistry.ts            # Prompt 注册表 (保留供未来使用)
│   └── patchUtils.ts                # Prompt 补丁工具
├── plugins/
│   └── PluginMonitor.ts             # 插件更新监控
├── startup/
│   ├── configValidation.ts          # 启动时配置验证
│   ├── errorRecovery.ts             # 错误恢复
│   └── gracefulShutdown.ts          # 优雅退出信号处理
├── client/
│   └── Client.ts                    # HTTP 客户端 (调用服务端 API)
├── types/
│   └── constants.ts                 # 全局常量
└── web/                             # SPA 前端 (HTML/CSS/JS + marked.js)
```

## 配置

`~/.db-coder/config.json`:

```jsonc
{
  "brain": { "model": "opus", "scanInterval": 300 },
  "claude": { "model": "opus", "maxTaskBudget": 10.0, "maxTurns": 200 },
  "codex": {
    "model": "gpt-5.3-codex",
    "tokenPricing": {
      "inputPerMillion": 1.75,
      "cachedInputPerMillion": 0.175,
      "outputPerMillion": 14
    }
  },
  "routing": {
    "brain":   { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "plan":    { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "execute": { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "review":  { "runtime": "codex-cli",  "model": "gpt-5.3-codex" },
    "reflect": { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "scan":    { "runtime": "claude-sdk", "model": "claude-opus-4-6" }
  },
  "autonomy": { "maxReviewFixes": 1 },
  "experimental": { "strictModelRouting": false },
  "budget": { "maxPerTask": 20.0, "maxPerDay": 300.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18801, "host": "127.0.0.1" },
  "git": { "branchPrefix": "db-coder/", "protectedBranches": ["main", "master"] }
}
```

项目级覆盖：`<project>/.db-coder.json`

注：`autonomy.worker` 已废弃，保留仅为兼容旧配置；当前实际路由以 `routing.execute` / `routing.review` 为准。

## 依赖

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.x",
    "@openai/codex-sdk": "^0.111.x",
    "postgres": "^3.4.x",
    "commander": "^13.x"
  }
}
```

注：Codex SDK 仍依赖系统安装的 `codex` CLI；Claude / Codex 的可用性会在启动阶段验证。

## 设计原则 (从 v1 失败中提炼)

1. **失败必须可见** — 关键路径不允许 catch-ignore，错误向上冒泡并记录
2. **单一记忆源** — CLAUDE.md + claude-mem，不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板，让 session 用自己的工具链自主推理
4. **可验证的进化** — diff CLAUDE.md 就能看到进化历程
5. **硬验证优先** — tsc + test 是唯一真实质量信号
6. **极简编排** — 编排器只做控制流，不做 AI 推理
7. **端到端闭环** — 每条链路必须可测试验证
