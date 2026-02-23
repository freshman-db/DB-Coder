# DB-Coder

**自主 AI 编码 Agent** — 持续扫描代码库、规划改进、自动执行并审查代码变更。

[English](./README.md)

---

## 概述

DB-Coder 是一个全自主的 AI 编码系统，通过 **大脑决策 → 工人执行 → 硬验证 → 审查 → 反思** 循环持续改进目标项目。它使用两个独立的 Claude Code CLI session —— 只读的"大脑"负责决策，读写的"工人"负责执行 —— 并用 Codex CLI 进行交叉审查。

### 核心能力

- **自主巡逻** — 完整的 大脑决策 → 工人执行 → 硬验证 → Codex 审查 → 大脑反思 循环，通过 Web UI 启停
- **双重审查** — Claude Code + Codex CLI 并行审查，交集问题为 must-fix
- **硬验证** — TypeScript 错误计数对比基线，阻止合并劣化代码
- **自然进化** — 大脑反思时直接编辑 CLAUDE.md (规则/状态) + 写入 claude-mem (经验)，无数值评分
- **Web UI** — 实时任务监控、日志流、费用追踪、巡逻控制
- **Git 安全** — 所有变更在隔离的 `db-coder/*` 分支上，验证通过后才合并到 main

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                  MainLoop 编排器                         │
│     brainDecide → workerExecute → hardVerify            │
│       → codexReview → brainReflect → merge              │
├─────────────┬─────────────────────────┬─────────────────┤
│  大脑 session │      工人 session       │   Codex CLI     │
│  (只读)      │      (读写)             │   (审查)        │
│  Claude Code │      Claude Code       │  gpt-5.3-codex  │
├─────────────┴─────────────────────────┴─────────────────┤
│  CLAUDE.md + claude-mem          TaskStore (PostgreSQL)  │
│  (规则 / 经验)                   (任务 / 日志 / 费用)    │
├─────────────────────────────────────────────────────────┤
│              HTTP Server (:18800)                        │
│       REST API + Web SPA + SSE 流式传输                  │
└─────────────────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts                         # CLI 入口 (commander)
├── core/
│   ├── MainLoop.ts                  # 核心编排循环 (~530行)
│   ├── ModeManager.ts               # PatrolManager (巡逻启停)
│   ├── TaskQueue.ts                 # 任务队列 (从 DB 获取)
│   ├── Shutdown.ts                  # 优雅退出
│   └── ModuleScheduler.ts           # 模块扫描调度
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Code CLI stream-json 封装 (~230行)
│   ├── CodingAgent.ts               # ReviewResult / ReviewIssue 接口
│   └── CodexBridge.ts               # Codex CLI 子进程封装
├── memory/
│   ├── TaskStore.ts                 # PostgreSQL: 任务/日志/费用/计划
│   ├── GlobalMemory.ts              # PostgreSQL: 全局记忆 (逐步淡出)
│   └── ProjectMemory.ts             # claude-mem HTTP 客户端
├── server/
│   ├── Server.ts                    # HTTP 服务 (API + 静态文件 + 安全头)
│   ├── routes.ts                    # REST API 路由 (~600行)
│   └── rateLimit.ts                 # 速率限制
├── config/
│   ├── Config.ts                    # 配置加载 (全局 + 项目级)
│   └── types.ts                     # 配置类型
├── utils/                           # Git、费用追踪、进程管理、日志等
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
  "brain": { "model": "opus", "scanInterval": 3600 },
  "claude": { "model": "opus", "maxTaskBudget": 2.0 },
  "budget": { "maxPerTask": 5.0, "maxPerDay": 200.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18800, "host": "127.0.0.1" }
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

打开 `http://127.0.0.1:18800`。API 令牌在启动日志中显示，或查看 `~/.db-coder/config.json`。

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

服务运行在 `http://127.0.0.1:18800`，所有 API 需要 Bearer Token 认证。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态 |
| GET | `/api/status/stream` | SSE 实时状态 |
| GET | `/api/metrics` | 运营指标 |
| GET/POST | `/api/tasks` | 任务列表/创建 |
| GET | `/api/tasks/:id` | 任务详情 |
| POST | `/api/control/pause` | 暂停循环 |
| POST | `/api/control/resume` | 恢复循环 |
| POST | `/api/control/scan` | 触发扫描 |
| POST | `/api/patrol/start` | 启动巡逻 |
| POST | `/api/patrol/stop` | 停止巡逻 |
| GET | `/api/logs?follow=true` | SSE 日志流 |
| GET | `/api/cost` | 费用详情 |
| GET | `/api/plans` | 计划列表 (只读) |
| POST | `/api/plans/:id/approve` | 审批计划 |
| POST | `/api/plans/:id/reject` | 驳回计划 |

## 工作原理

### 大脑+工人模式

编排器 (MainLoop) 驱动两个独立的 Claude Code CLI session：

1. **大脑 Session**（只读）— 读取 CLAUDE.md 和查询 claude-mem 了解项目状态，然后决定执行什么任务。输出结构化 JSON 决策。

2. **工人 Session**（读写）— 在隔离的 Git 分支上执行选定的任务。使用 Claude Code 完整工具集进行代码读写和测试。

3. **硬验证** — 运行 `tsc` 并对比基线错误计数。新增错误会触发工人 session 续传修复。

4. **Codex 审查** — Codex CLI 独立审查 git diff。结果通过 `mergeReviews()` 与大脑评估交叉验证。

5. **大脑反思** — 大脑分析任务结果，编辑 CLAUDE.md 添加新规则/教训，并将经验保存到 claude-mem 供未来参考。

### 自然进化

系统不使用数值评分（v1 已证明无效），而是通过以下方式进化：

- **编辑 CLAUDE.md**：大脑根据任务结果直接增删改规则
- **写入 claude-mem**：语义化经验存储，未来决策时按相关性检索
- **Git 历史**：`git log CLAUDE.md` 就是完整的进化时间线

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript / Node.js (ESM) |
| 大脑/工人 | Claude Code CLI (`--output-format stream-json`) |
| 审查器 | Codex CLI (`gpt-5.3-codex`) |
| 数据库 | PostgreSQL + `pg_trgm`，通过 `postgres` (porsager) |
| 经验积累 | CLAUDE.md + claude-mem HTTP API |
| Web UI | 原生 HTML/CSS/JS SPA + marked.js |
| HTTP 服务 | Node.js `http` 模块 |

## 许可证

MIT
