# DB-Coder

**自主 AI 编码 Agent** — 持续扫描代码库、规划改进、自动执行并审查代码变更。

[English](./README.md)

---

## 概述

DB-Coder 是一个全自主的 AI 编码系统，通过 **大脑决策 → 方案分析 → 工人执行 → 硬验证 → 代码审查 → 大脑裁决 → 反思** 循环持续改进目标项目。它使用只读"大脑"session 负责决策和裁决，可切换的 Worker（Claude Code 或 Codex）负责执行，以及自动互斥的审查者进行质量门禁。

### 核心能力

- **自主巡逻** — 完整的 大脑决策 → [方案分析 M/L/XL] → 工人执行 → 硬验证 → 代码审查 → 大脑裁决 → 反思 循环，通过 Web UI 启停
- **Worker 可切换** — Claude Code 或 Codex 作为执行者 (`autonomy.worker` 配置)，审查者自动选择互斥模型
- **大脑裁决** — 审查失败后大脑 5 选 1 决策 (fix / ignore / block / rewrite / split)，替代二元通过/失败
- **硬验证** — TypeScript 错误计数对比基线，阻止合并劣化代码
- **自然进化** — 大脑反思时直接编辑 CLAUDE.md (规则/状态) + 写入 claude-mem (经验)，无数值评分
- **Web UI** — 实时任务监控、日志流、费用追踪、巡逻控制
- **Git 安全** — 所有变更在隔离的 `db-coder/*` 分支上，验证通过后才合并到 main

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    MainLoop 编排器                             │
│  brainDecide → [方案分析 M/L/XL] → workerExecute → hardVerify │
│    → codeReview → brainReviewDecision → [修复循环] → merge     │
├──────────────┬──────────────────────┬────────────────────────┤
│  大脑 session │    WorkerAdapter     │    ReviewAdapter        │
│  (决策+裁决)  │    (可切换执行)       │    (自动互斥审查)       │
│  Claude Code │    Claude / Codex    │    Codex / Claude       │
├──────────────┴──────────────────────┴────────────────────────┤
│  CLAUDE.md + claude-mem          TaskStore (PostgreSQL)       │
│  (规则 / 经验)                   (任务 / 日志 / 费用)         │
├──────────────────────────────────────────────────────────────┤
│                HTTP Server (:18801)                           │
│         REST API + Web SPA + SSE 流式传输                     │
└──────────────────────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts                         # CLI 入口 (commander)
├── core/
│   ├── MainLoop.ts                  # 核心编排循环 (~3200行, 含方案阶段+审查决策+修复循环)
│   ├── WorkerAdapter.ts             # WorkerAdapter + ReviewAdapter 接口 + 4个实现 (~210行)
│   ├── PersonaLoader.ts             # Persona 加载 + Skill 映射 + Worker Prompt 构建
│   ├── CycleEventBus.ts             # 类型化事件总线 (循环生命周期)
│   ├── ModeManager.ts               # PatrolManager (巡逻启停)
│   ├── TaskQueue.ts                 # 任务队列 (从 DB 获取)
│   ├── Shutdown.ts                  # 优雅退出
│   ├── guards/                      # BudgetGuard, ConcurrencyGuard, EmptyDiffGuard 等
│   ├── observers/                   # CycleMetricsCollector, NotificationObserver 等
│   └── strategies/                  # DynamicPriority, FailureLearning, TaskQuality
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
│   └── ProjectMemory.ts             # claude-mem HTTP 客户端
├── server/
│   ├── Server.ts                    # HTTP 服务 (API + 静态文件 + 安全头)
│   ├── routes.ts                    # REST API 路由 (~900行)
│   └── rateLimit.ts                 # 速率限制
├── config/
│   ├── Config.ts                    # 配置加载 (全局 + 项目级)
│   └── types.ts                     # 配置类型
├── utils/                           # Git、费用追踪、进程管理、日志、校验等
└── web/                             # SPA 前端 (HTML/CSS/JS + marked.js)
```

## 快速开始

### 前置要求

- Node.js >= 22
- PostgreSQL（推荐 Docker）
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（全局安装）
- [Codex CLI](https://github.com/openai/codex)（可选，用于双重审查）

### 安装

```bash
# 克隆仓库
git clone https://github.com/freshman-db/DB-Coder.git
cd DB-Coder

# 安装依赖
npm install

# 启动 PostgreSQL (Docker)
docker run -d --name dev-postgres \
  -e POSTGRES_USER=db -e POSTGRES_PASSWORD=db -e POSTGRES_DB=db_coder \
  -p 5432:5432 postgres:16

# 启用 pg_trgm 扩展
docker exec -i dev-postgres psql -U db -d db_coder -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# 构建
npm run build
```

### 配置

全局配置文件：`~/.db-coder/config.json`

```jsonc
{
  "brain": { "model": "opus", "scanInterval": 300 },
  "claude": { "model": "opus", "maxTaskBudget": 10.0, "maxTurns": 200 },
  "codex": { "model": "gpt-5.3-codex", "tokenPricing": { "inputPerMillion": 1.75, "cachedInputPerMillion": 0.175, "outputPerMillion": 14 } },
  "autonomy": { "worker": "claude", "maxReviewFixes": 1 },
  "budget": { "maxPerTask": 20.0, "maxPerDay": 300.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18801, "host": "127.0.0.1" }
}
```

项目级覆盖：`<project>/.db-coder.json`

### 启动

```bash
# 作为服务运行（相对路径会自动 resolve）
node dist/index.js serve --project .

# 或指定绝对路径
db-coder serve --project /path/to/your/project

# 生产环境：使用 supervisor 脚本自动重启
nohup bash supervisor.sh > logs/nohup.out 2>&1 &
```

打开 `http://127.0.0.1:18801`。API 令牌在启动日志中显示，或查看 `~/.db-coder/config.json`。

### CLI 命令

```bash
db-coder serve -p <path>    # 启动服务
db-coder status              # 查看状态
db-coder add "任务描述"       # 添加任务
db-coder queue               # 查看任务队列
db-coder scan [--deep]       # 触发扫描
db-coder logs -f             # 实时日志
db-coder cost                # 查看费用
db-coder pause / resume      # 暂停/恢复
```

## Web UI

- **仪表盘** — 系统状态、巡逻控制、快捷操作
- **巡逻模式** — 通过顶栏按钮启停，实时显示状态（扫描中、执行中、审查中等）
- **任务列表** — 查看、筛选、管理任务，支持分页
- **运行日志** — SSE 实时日志流，支持级别过滤
- **系统设置** — 当前项目、系统状态、费用追踪

## API

服务运行在 `http://127.0.0.1:18801`，所有 API 需要 Bearer Token 认证。

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
| POST | `/api/control/pause` | 暂停循环 |
| POST | `/api/control/resume` | 恢复循环 |
| POST | `/api/control/scan` | 触发扫描 |
| POST | `/api/patrol/start` | 启动巡逻 |
| POST | `/api/patrol/stop` | 停止巡逻 |
| GET | `/api/logs?follow=true` | SSE 日志流 |
| GET | `/api/cost` | 费用详情 |
| GET | `/api/cycle/metrics` | 循环性能指标 |
| GET | `/api/cycle/entries` | 循环历史记录 |
| GET | `/api/personas` | Persona 列表 |
| PUT | `/api/personas/:name` | 更新 Persona 内容 |
| GET | `/api/plans` | 计划列表 (只读) |
| POST | `/api/plans/:id/approve` | 审批计划 |
| POST | `/api/plans/:id/reject` | 驳回计划 |

## 工作原理

### 大脑 + Worker + Reviewer 模式

编排器 (MainLoop) 驱动大脑 session、可切换的 Worker、以及自动互斥的 Reviewer：

1. **大脑 Session**（只读+裁决）— 读取 CLAUDE.md 和查询 claude-mem 了解项目状态，决定执行什么任务。同时负责方案审批和审查后的裁决。

2. **方案阶段**（仅 M/L/XL 任务）— Worker 进行只读代码分析 → Reviewer 审查方案 → 大脑汇总批准/否决。S 任务跳过此阶段。

3. **Worker 执行**（可切换: Claude Code 或 Codex）— 在隔离的 Git 分支上执行任务（含已批准的方案）。Worker 类型通过 `autonomy.worker` 配置。

4. **硬验证** — 运行 `tsc` 并对比基线错误计数。新增错误触发 Worker 修复（Claude 续传 session / Codex 新 session）。

5. **代码审查**（自动互斥）— 审查者自动选择与 Worker 不同的模型（worker=Claude → Codex 审查，worker=Codex → Claude 审查）。

6. **大脑裁决** — 大脑分析审查结果做 5 选 1 决策：**fix**（发给 Worker 修复）、**ignore**（忽略问题直接合并）、**block**（阻止）、**rewrite**（重写方案）、**split**（合并部分 + 创建后续任务）。Fix/rewrite 最多触发 1 轮重试。

7. **大脑反思** — 大脑分析任务结果，编辑 CLAUDE.md 添加新规则/教训，并将经验保存到 claude-mem 供未来参考。

### 自然进化

系统不使用数值评分（v1 已证明无效），而是通过以下方式进化：

- **编辑 CLAUDE.md**：大脑根据任务结果直接增删改规则
- **写入 claude-mem**：语义化经验存储，未来决策时按相关性检索
- **Git 历史**：`git log CLAUDE.md` 就是完整的进化时间线

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript / Node.js (ESM) |
| 大脑 | Claude Code CLI (`--output-format stream-json`，只读) |
| Worker | Claude Code 或 Codex CLI（通过 `autonomy.worker` 配置切换） |
| 审查器 | 自动选择与 Worker 互斥的模型 |
| 数据库 | PostgreSQL + `pg_trgm`，通过 `postgres` (porsager) |
| 经验积累 | CLAUDE.md + claude-mem HTTP API |
| Web UI | 原生 HTML/CSS/JS SPA + marked.js |
| HTTP 服务 | Node.js `http` 模块 |

## 许可证

MIT
