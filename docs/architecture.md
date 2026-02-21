# db-coder: 自主 AI 编码 Agent

## 愿景

一个能长时间自主运行的编码 agent，像"技术负责人"一样主动发现问题、制定开发计划、执行改进、积累经验。以 systemd 服务部署在 24 小时工作站上，通过 CLI 客户端随时交互。

## 核心决策

| 决策项 | 选择 |
|--------|------|
| 语言 | TypeScript |
| 大脑层 | Claude Code Agent SDK (plan mode, Opus) |
| 前端执行 | Claude Code (有 frontend-design 插件) |
| 后端执行 | Codex CLI |
| 审查 | Claude Code + Codex CLI (双重并行) |
| 经验提取 | Claude 主动总结 |
| 全局记忆 | PostgreSQL (Docker) + pg_trgm |
| 项目记忆 | claude-mem (HTTP API) |
| 任务存储 | PostgreSQL (同一实例) |
| 自主级别 | 完全自主 (分支隔离保安全) |
| 运行模式 | systemd 服务 + CLI 客户端 |
| 卡住处理 | 分级: 重试→反思→跳过 |
| Git 策略 | db-coder/* 分支隔离 |
| 多项目 | MVP 先单项目 |

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│              db-coder 服务 (systemd, 24h 运行)           │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Main Loop (持续运行)                   │  │
│  │   SCAN → PLAN → EXECUTE → REVIEW → REFLECT       │  │
│  │     ↑                                   │          │  │
│  │     └───────────── 下一轮 ←─────────────┘          │  │
│  └───────────────────────────────────────────────────┘  │
│         │              │              │                   │
│         ▼              ▼              ▼                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐       │
│  │  Brain   │  │  Claude  │  │    Codex CLI     │       │
│  │  (SDK    │  │  Code    │  │  (后端执行+审查)  │       │
│  │  plan)   │  │  (前端)  │  └──────────────────┘       │
│  └──────────┘  └──────────┘                              │
│                                                         │
│  ┌───────────────┐  ┌──────────────────┐                │
│  │  HTTP API     │  │  Memory Layer    │                │
│  │  :18800       │  │  PG + claude-mem │                │
│  └───────┬───────┘  └──────────────────┘                │
└──────────┼──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│  db-coder CLI 客户端  │  (随时从任何终端运行)
│                      │
│  db-coder status     │
│  db-coder add "任务"  │
│  db-coder logs -f    │
│  db-coder pause      │
└──────────────────────┘
```

## 三层 Agent 架构

### Layer 1: Brain — 战略层 (Agent SDK, plan mode, Opus)
- 职责: 扫描、分析、规划、反思、经验提取
- 工具: 只读 (Read, Grep, Glob, Bash for git/test/lint)
- 特点: 能读代码理解架构，但不修改任何文件

### Layer 2: Claude Code — 前端执行层 (Agent SDK, execute mode)
- 职责: 前端 UI 组件、样式、页面的实现
- 工具: 完整 Claude Code 工具集 + frontend-design 插件
- 路由: Brain 判断为前端任务时使用

### Layer 3: Codex CLI — 后端执行层
- 职责: 后端代码实现、测试编写
- 工具: codex exec --full-auto

### 双重审查机制
Claude Code + Codex CLI **并行**审查同一份代码变更:
- Claude Code 审查: Agent SDK query() + review prompt (侧重架构/设计/前端)
- Codex CLI 审查: codex exec review (侧重逻辑/安全/测试)
- 合并策略: **交集优先** — 两者都标记的问题必须修复；仅一方标记的降低优先级但记录
- 两者都通过才算通过；任一方发现必修问题则回到 EXECUTE

### 智能路由
```
Brain 在 PLAN 阶段判断:
  前端任务 (UI/组件/样式) → Claude Code (frontend-design)
  后端任务 (API/DB/逻辑)  → Codex CLI
  测试任务               → Codex CLI
  全栈任务               → 拆分为前端+后端子任务
```

## 自主运行循环

```
SCAN (Brain, plan mode)
  - 扫描项目: git log, 代码质量, TODO/FIXME, 测试覆盖
  - 变更检测: 只在代码变化时扫描
  - 扫描深度: quick(<5 files) / normal(定时) / deep(首次/大量变更)
  ▼
PLAN (Brain, plan mode)
  - 根据扫描 + 全局记忆 + 项目记忆制定任务
  - 优先级: P0紧急 → P3可选
  - 路由: 判断前端/后端，分配给对应 executor
  - 完全自主，无需用户批准
  ▼
EXECUTE (Claude Code 或 Codex CLI)
  - 创建 Git 分支: db-coder/<task-id>
  - 按子任务顺序执行，每步 git commit
  - 失败时分级处理: 重试→Brain反思→跳过
  ▼
REVIEW (Claude Code + Codex CLI 并行)
  - Claude Code: Agent SDK review (架构/设计/前端)
  - Codex CLI: codex exec review (逻辑/安全/测试)
  - 合并结果: 交集=必修, 单方=可选
  - 不通过时回到 EXECUTE 修复 (最多 3 轮)
  ▼
REFLECT (Brain, plan mode)
  - 分析执行结果
  - 提取通用编程经验 → 全局记忆 (PG)
  - 保存任务摘要 → 项目记忆 (claude-mem)
  - 调整后续计划
  ▼
继续下一个任务... 或休眠等待变更
```

## 双层记忆系统

### 全局记忆 (PostgreSQL, Docker)

跨项目通用知识: 编程习惯、经验、规范、流程、框架知识。

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE memories (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('habit','experience','standard','workflow','framework')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags JSONB DEFAULT '[]',
  source_project TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memories_title_trgm ON memories USING gin (title gin_trgm_ops);
CREATE INDEX idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX idx_memories_tags ON memories USING gin (tags);
CREATE INDEX idx_memories_fts ON memories USING gin (to_tsvector('simple', title || ' ' || content));
```

经验提取: Brain 在 REFLECT 阶段用 Agent SDK 总结通用经验。
置信度: 新记忆 0.5，跨项目验证 +0.2，用户手动 1.0。
查询注入: 按 relevance * confidence 排序，token 上限 ~2000。

### 项目记忆 (claude-mem HTTP API :37777)

项目特定: 架构决策、文件结构、任务历史。优雅降级。

### 任务/扫描状态 (同一 PG 实例)

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_path TEXT NOT NULL,
  task_description TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'init',
  priority INTEGER DEFAULT 2,
  plan JSONB,
  subtasks JSONB DEFAULT '[]',
  review_results JSONB DEFAULT '[]',
  iteration INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  git_branch TEXT,
  start_commit TEXT,
  status TEXT DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_logs (
  id SERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL, agent TEXT NOT NULL,
  input_summary TEXT, output_summary TEXT,
  cost_usd NUMERIC(10,4), duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE scan_results (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  depth TEXT NOT NULL, result JSONB NOT NULL,
  health_score INTEGER, cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE daily_costs (
  date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  task_count INTEGER DEFAULT 0
);
```

## 分级卡住处理

```
第 1 次失败: 自动重试
第 2 次失败: Brain 反思 — 分析原因，调整策略
第 3 次失败: 跳过，标记 blocked，通过日志 + Web UI 显示警告
```

## 服务 + 客户端架构

### 服务端 (db-coder serve)

后台服务，通过 systemd 管理，暴露本地 HTTP API:

```
POST /api/tasks              — 添加任务
GET  /api/tasks              — 列出任务
GET  /api/tasks/:id          — 任务详情
DELETE /api/tasks/:id        — 取消任务
POST /api/control/pause      — 暂停
POST /api/control/resume     — 恢复
POST /api/control/scan       — 触发扫描
GET  /api/status             — 当前状态
GET  /api/logs?follow=true   — 日志流 (SSE)
GET  /api/memory?q=...       — 搜索记忆
POST /api/memory             — 添加记忆
GET  /api/cost               — 费用明细
```

使用 Node.js 内置 `http` 模块（不加框架依赖），监听 localhost:18800。

### 客户端 (db-coder CLI)

```bash
db-coder status                    # 查看服务状态
db-coder add "添加JWT认证"          # 添加任务
db-coder add -p0 "紧急修复"         # 高优先级任务
db-coder queue                     # 查看任务队列
db-coder logs -f                   # 实时日志 (SSE)
db-coder pause / resume            # 暂停/恢复
db-coder scan                      # 触发扫描
db-coder scan --deep               # 深度扫描
db-coder memory search "react"     # 搜索记忆
db-coder memory add -c habit "..." # 添加记忆
db-coder cost                      # 费用
db-coder blocked                   # 查看阻塞任务
```

### systemd 服务配置

```ini
# /etc/systemd/system/db-coder.service
[Unit]
Description=db-coder AI Coding Agent
After=network.target docker.service

[Service]
Type=simple
User=db
ExecStart=/home/db/.nvm/versions/node/v24.13.0/bin/node /home/db/projects/db-coder/dist/index.js serve
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Web 管理界面

同一 HTTP 服务 (:18800) 同时提供 API 和 Web 界面。

### 功能
- **仪表盘**: 当前状态 (运行中/暂停/空闲)、当前任务、健康评分、今日费用
- **任务列表**: 全部任务，按状态筛选，优先级排序
- **任务详情**: 子任务进度、执行日志、Git 分支、费用明细
- **运行历史**: 所有 SCAN→PLAN→EXECUTE→REVIEW→REFLECT 的完整记录
- **实时日志**: SSE 驱动的实时日志流
- **记忆查看**: 搜索和浏览全局记忆
- **控制面板**: 暂停/恢复、触发扫描、添加任务

### 技术方案
- **静态 SPA**: 同一服务器 serve，无额外进程
- **纯前端**: HTML + CSS + 原生 JS (零构建依赖)
- **响应式**: 手机/平板/PC 均可访问
- **SSE 日志**: EventSource API 实现实时日志
- **路由**: `/` 访问 Web UI，`/api/*` 访问 REST API

### 页面结构
```
/                  → 仪表盘 (Dashboard)
/tasks             → 任务列表
/tasks/:id         → 任务详情
/history           → 运行历史 (时间线)
/logs              → 实时日志
/memory            → 记忆搜索
/settings          → 配置查看 (只读)
```

前端文件放在 `src/web/` 下，编译后嵌入到服务中。

## 安全保障

1. Git 分支隔离 (不动 main/master)
2. 预算上限 (单任务$5 / 每日$20)
3. 项目目录内操作
4. Codex 沙箱 (workspace-write)
5. Web UI + CLI 随时可介入

## 初始化/冷启动

首次运行: 检查 PG → 创建表 → 深度扫描 → 开始规划。
全局记忆为空时: 不影响功能，随使用自然积累。
可选: seed-memories.json 预填基础规范。

## 工具协作/冲突处理

- 锁文件防止并发: ~/.db-coder/<project-hash>.lock
- 执行前检查工作区是否干净
- Agent SDK 设置 persistSession: false，不污染用户 session
- 移除 CLAUDE_CODE 环境变量避免嵌套冲突

## 目录结构

```
src/
  index.ts                      # CLI 入口 (客户端 + 服务启动) (~100)
  server/
    Server.ts                   # HTTP 服务 (Node.js http 模块) (~200)
    routes.ts                   # API 路由定义 (~150)
  client/
    Client.ts                   # HTTP 客户端 (调用服务端 API) (~150)
  core/
    MainLoop.ts                 # 主循环 (~250)
    Brain.ts                    # 战略层 (~400)
    TaskQueue.ts                # 优先级队列 (~150)
    types.ts                    # 核心类型 (~150)
  bridges/
    CodingAgent.ts              # 通用接口 (~50)
    ClaudeBridge.ts             # Agent SDK 封装 (~300)
    CodexBridge.ts              # Codex CLI 封装 (~250)
  memory/
    GlobalMemory.ts             # PG 全局记忆 (~250)
    ProjectMemory.ts            # claude-mem 客户端 (~150)
    TaskStore.ts                # PG 任务状态 (~150)
    types.ts                    # 记忆类型 (~50)
  prompts/
    brain.ts                    # Brain 系统 prompt (~100)
    planner.ts                  # 规划 prompt (~80)
    executor.ts                 # 执行 prompt (~60)
    reviewer.ts                 # 审查 prompt (~60)
    extractor.ts                # 经验提取 prompt (~60)
  web/
    index.html                  # SPA 入口 + 路由
    style.css                   # 全局样式
    app.js                      # 主逻辑 (fetch API + SSE + 渲染)
  config/
    Config.ts                   # 配置加载 (~100)
    types.ts                    # 配置类型 (~100)
  utils/
    logger.ts                   # 日志 (~80)
    process.ts                  # 子进程 (~80)
    git.ts                      # Git 操作 (~120)
    cost.ts                     # 费用追踪 (~80)
```

~4000 行 TypeScript + Web

## 配置

`~/.db-coder/config.json`:
```json
{
  "brain": { "model": "opus", "scanInterval": 3600, "maxScanBudget": 1.0 },
  "claude": { "model": "opus", "maxTaskBudget": 2.0, "maxTurns": 30 },
  "codex": { "model": "o3", "sandbox": "workspace-write" },
  "autonomy": { "level": "full", "maxRetries": 3, "subtaskTimeout": 600 },
  "routing": {
    "scan": "brain", "plan": "brain",
    "execute_frontend": "claude", "execute_backend": "codex",
    "review": ["claude", "codex"], "reflect": "brain"
  },
  "budget": { "maxPerTask": 5.0, "maxPerDay": 20.0, "warningThreshold": 0.8 },
  "memory": {
    "claudeMemUrl": "http://localhost:37777",
    "pgConnectionString": "postgresql://user:pass@localhost:5432/db_coder"
  },
  "git": { "branchPrefix": "db-coder/", "protectedBranches": ["main","master"] }
}
```

## 依赖

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.77",
    "postgres": "^3.4.0",
    "commander": "^12.0.0"
  }
}
```

## 实施顺序

### Phase 1: 基础设施
配置系统 + 全局记忆(PG) + 项目记忆(claude-mem) + 任务存储 + 工具函数

### Phase 2: Bridges
CodingAgent 接口 + ClaudeBridge (Agent SDK) + CodexBridge (CLI)

### Phase 3: 核心引擎
Brain + TaskQueue + MainLoop + 所有 Prompt 模板

### Phase 4: 服务 + Web UI + 集成
HTTP 服务 + Web 界面 + CLI 客户端 + 端到端测试

## Prompt 设计

### Brain 系统 prompt
定义角色为"自主技术负责人"，注入全局记忆和项目上下文。

### SCAN prompt
引导 Brain 用 Claude Code 工具扫描: git log, TODO/FIXME, 代码质量, 安全, 性能。
输出 JSON: issues[] + opportunities[] + projectHealth。

### PLAN prompt
引导优先级排序 (P0-P3)、路由判断 (前端→claude/后端→codex)、任务分解。
输出 JSON: tasks[{subtasks, executor, dependsOn}]。

### EXECUTE prompt
注入全局规范 (category='standard') + 子任务上下文。

### REVIEW prompt
对比原始计划 vs 实际变更，检查功能/质量/安全/测试。

### EXTRACT prompt
从任务结果中提取通用编程经验，输出 JSON: [{category, title, content, tags}]。
