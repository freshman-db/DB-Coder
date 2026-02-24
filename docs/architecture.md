# db-coder: 自主 AI 编码 Agent (v2)

## 愿景

一个能长时间自主运行的编码 agent，通过"大脑+工人"双 session 架构主动发现问题、制定计划、执行改进、积累经验。以 systemd 服务部署在 24 小时工作站上，通过 Web UI 随时交互。

## 核心决策

| 决策项 | 选择 |
|--------|------|
| 语言 | TypeScript (ESM) |
| 大脑 | Claude Code CLI (stream-json, 只读 session) |
| 工人 | Claude Code CLI (stream-json, 读写 session) |
| 审查 | Claude Code + Codex CLI (双重并行) |
| 硬验证 | tsc 错误计数对比基线 |
| 经验积累 | CLAUDE.md (规则/状态) + claude-mem (语义搜索) |
| 任务存储 | PostgreSQL (Docker) |
| 自主级别 | 完全自主 (Git 分支隔离) |
| 运行模式 | systemd 服务 + Web UI |
| Git 策略 | db-coder/* 分支隔离 |

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│              db-coder 服务 (systemd, 24h 运行)           │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │            Main Loop 编排器 (~2400行)              │  │
│  │  brainDecide → workerExecute → hardVerify         │  │
│  │      → codexReview → brainReflect → merge         │  │
│  │     ↑                                │             │  │
│  │     └────────────── 下一轮 ←──────────┘             │  │
│  └───────────────────────────────────────────────────┘  │
│         │               │              │                 │
│         ▼               ▼              ▼                 │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐      │
│  │ 大脑 session │  │ 工人 session │  │  Codex CLI   │      │
│  │ (只读+决策)  │  │ (读写+执行)  │  │  (审查)      │      │
│  │ Claude Code │  │ Claude Code │  │ gpt-5.3-codex│      │
│  └────────────┘  └────────────┘  └──────────────┘      │
│                                                         │
│  ┌───────────────┐  ┌──────────────────┐               │
│  │  HTTP Server  │  │   CLAUDE.md      │               │
│  │  :18800       │  │   + claude-mem   │               │
│  │  API + Web UI │  │   (经验积累)     │               │
│  └───────────────┘  └──────────────────┘               │
│                                                         │
│  ┌──────────────────────────────────────┐               │
│  │  PostgreSQL (Docker)                 │               │
│  │  tasks / task_logs / daily_costs     │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

## 大脑+工人架构

### 大脑 Session (ClaudeCodeSession, 只读)

- 职责: 项目扫描、任务决策、执行后反思、经验积累
- 工具: 只读 (disallowedTools: Edit, Write, NotebookEdit)
- 输入: 自动读取 CLAUDE.md (项目状态/规则/链路定义) + claude-mem (相关经验)
- 输出: JSON 结构化决策 (通过 --json-schema 约束)
- 反思时: 切换为可编辑模式，直接更新 CLAUDE.md + 写入 claude-mem

### 工人 Session (ClaudeCodeSession, 读写)

- 职责: 具体编码任务执行
- 工具: 完整工具集 (bypassPermissions)
- 特点: 自动读取 CLAUDE.md 获取环境规则和项目上下文
- 输出: SessionResult (包含 sessionId, 用于 workerFix 续传)

### Codex CLI 审查

- 职责: diff 级别的代码审查
- 工具: codex exec --full-auto
- 与大脑 session 审查结果**交叉验证**: 两者都标记的问题为 mustFix，仅一方标记的为 shouldFix
- 只有 critical/high 级别的 mustFix 才阻止合并

## 自主运行循环

```
brainDecide (大脑 session, 只读)
  - 读取 CLAUDE.md + 查询 claude-mem
  - 分析项目当前状态，选择最有价值的任务
  - 输出: 任务描述 + 优先级 + 审查指令
  ▼
workerExecute (工人 session, 读写)
  - 在 Git 分支 db-coder/<task-id> 上执行
  - 自动读取 CLAUDE.md 获取环境规则
  - 编码 + git commit，返回 SessionResult
  ▼
hardVerify (shell: tsc)
  - 对比 tsc 错误计数: 执行后 vs 基线
  - 新增错误 → workerFix (续传 session 修复)
  - 检查 git diff 是否有实际变更
  ▼
codexReview (Codex CLI)
  - codex exec 审查 git diff
  - 与 Claude 审查结果交叉验证
  - mergeReviews() 分类 mustFix / shouldFix
  ▼
brainReflect (大脑 session, 可编辑)
  - 分析任务结果、审查反馈
  - 更新 CLAUDE.md (新增/修改规则)
  - 写入 claude-mem (经验教训)
  ▼
mergeBranch (验证通过时)
  - 合并到 main，清理分支
  - 继续下一个任务
```

## 记忆与进化

### CLAUDE.md (项目根目录)

大脑和工人的共享上下文，Claude Code 启动时自动读取。内容包括:

- 项目架构和当前状态
- 待办优先级
- 环境规则 (构建命令、DB 连接等)
- DB Schema
- 功能链路定义 (深度审查用)
- 踩过的坑 (经验教训)

大脑反思时直接编辑 CLAUDE.md，规则自然演化，diff 即进化历史。

### claude-mem (语义搜索)

项目级经验记忆，通过 HTTP API (:37777) 访问。大脑反思时写入，下次决策时语义查询相关经验。

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
       total_cost_usd, git_branch, start_commit, status, created_at

-- 执行日志
task_logs: id(serial), task_id(fk), phase, agent, input_summary,
           output_summary, cost_usd, duration_ms, created_at

-- 每日费用
daily_costs: date(pk), total_cost_usd, task_count

-- 计划草案 (v2 中 chat 相关字段暂停使用)
plan_drafts: id(serial), project_path, plan(jsonb), status,
             chat_session_id, chat_status, created_at

-- 聊天消息 (v2 暂停写入)
plan_chat_messages: id(serial), plan_draft_id(fk), role, content,
                    metadata(jsonb), created_at
```

### 停用表 (不删除，停止写入)

adjustments, memories, scan_modules, scan_results, evaluation_events,
review_events, goal_progress, prompt_versions, config_proposals

## 服务端架构

### HTTP Server (:18800)

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
│   ├── MainLoop.ts                  # 核心编排循环 (~2400行)
│   ├── MainLoop.test.ts             # 纯函数测试 (mergeReviews, countTscErrors 等)
│   ├── PersonaLoader.ts             # Persona 加载 + Skill 映射 + Worker Prompt 构建
│   ├── CycleEventBus.ts             # 类型化事件总线 (循环生命周期)
│   ├── CycleEvents.ts               # 循环事件类型定义
│   ├── ModeManager.ts               # PatrolManager (巡逻启停)
│   ├── PlanChatManager.ts           # 计划对话管理
│   ├── TaskQueue.ts                 # 任务队列 (从 DB 获取 queued 任务)
│   ├── Shutdown.ts                  # 优雅退出
│   ├── types.ts                     # 核心类型
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
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Code Agent SDK query() 封装 (~210行)
│   ├── sdkMessageCollector.ts       # SDK 流事件收集 + 错误合成
│   ├── buildSdkOptions.ts           # SDK 选项构建器
│   ├── hooks.ts                     # 程序化 PreToolUse/PostToolUse hooks
│   ├── pluginDiscovery.ts           # 自动发现 ~/.claude/plugins/cache 插件
│   ├── CodingAgent.ts               # ReviewResult / ReviewIssue 接口
│   └── CodexBridge.ts               # Codex CLI 子进程封装 + token 费用估算
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
  "codex": { "model": "gpt-5.3-codex", "tokenPricing": { "inputPerMillion": 1.75, "cachedInputPerMillion": 0.175, "outputPerMillion": 14 } },
  "budget": { "maxPerTask": 20.0, "maxPerDay": 300.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18800, "host": "127.0.0.1" },
  "git": { "branchPrefix": "db-coder/", "protectedBranches": ["main", "master"] }
}
```

项目级覆盖: `<project>/.db-coder.json`

## 依赖

```json
{
  "dependencies": {
    "postgres": "^3.4.0",
    "commander": "^12.0.0"
  }
}
```

注: Claude Code CLI 和 Codex CLI 作为系统工具安装，不在 npm 依赖中。

## 设计原则 (从 v1 失败中提炼)

1. **失败必须可见** — 关键路径不允许 catch-ignore，错误向上冒泡并记录
2. **单一记忆源** — CLAUDE.md + claude-mem，不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板，让 session 用自己的工具链自主推理
4. **可验证的进化** — diff CLAUDE.md 就能看到进化历程
5. **硬验证优先** — tsc + test 是唯一真实质量信号
6. **极简编排** — 编排器只做控制流，不做 AI 推理
7. **端到端闭环** — 每条链路必须可测试验证
