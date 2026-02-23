# DB-Coder

**自主 AI 编码 Agent** — 持续扫描代码库、规划改进、自动执行并审查代码变更。

[English](./README.md)

---

## 概述

DB-Coder 是一个全自主的 AI 编码系统，通过 **scan → plan → execute → review → reflect** 循环持续改进目标项目。它使用 Claude (Opus) 作为大脑进行分析和规划，Claude + Codex 作为双执行引擎，并对代码变更进行交叉审查。

### 核心能力

- **自主巡逻** — 无需人工干预的 scan → plan → execute → review → reflect 完整循环，通过 Web UI 启停
- **交互式计划对话** — 在 Web UI 中与 Claude 进行多轮对话，实时流式输出 Markdown 格式的回复，逐步梳理需求后生成可执行计划
- **双重审查** — Claude Code + Codex CLI 并行审查，交集问题为 must-fix
- **自我进化** — 从每次任务中提取经验，动态优化提示词模板
- **Meta-Prompt 反思** — Brain 定期分析提示词效果，提出节级补丁，自动追踪效果并回滚劣化版本
- **MCP 集成** — 自动发现 Claude 插件（Serena、Context7、Playwright 等）并按阶段分配
- **双层记忆** — PostgreSQL（全局经验）+ claude-mem（项目级上下文）
- **Web UI** — 实时任务监控、日志流、费用追踪、聊天式计划

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      Brain (Opus)                       │
│              scan / plan / reflect / evolve              │
├─────────────┬───────────────────────────┬───────────────┤
│ ClaudeBridge│     PromptRegistry        │  CodexBridge  │
│ (Agent SDK) │    (meta-prompt 补丁)      │ (codex exec)  │
├─────────────┴───────────────────────────┴───────────────┤
│          MainLoop              PlanWorkflow             │
│   巡逻: scan→plan→execute      对话: 多轮沟通            │
│   →review→reflect→merge        →研究→生成计划            │
├──────────────┬──────────────┬───────────────────────────┤
│  TaskStore   │ GlobalMemory │    EvolutionEngine        │
│  (PostgreSQL)│  (PostgreSQL)│  调整 / 趋势 /             │
│              │              │  meta-reflect / 补丁       │
├──────────────┴──────────────┴───────────────────────────┤
│              HTTP Server (:18800)                        │
│       REST API + Web SPA + SSE 流式传输                  │
└─────────────────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts                 # CLI 入口 (commander)，自动 resolve 相对路径
├── core/
│   ├── Brain.ts             # 扫描/规划/反思 (Agent SDK plan mode)
│   ├── MainLoop.ts          # 巡逻循环: scan→plan→execute→review→reflect
│   ├── ModeManager.ts       # PatrolManager (巡逻启停管理)
│   ├── PlanWorkflow.ts      # 聊天式计划工作流 (常驻 ChatSession + SSE)
│   └── TaskQueue.ts         # 任务队列管理
├── bridges/
│   ├── CodingAgent.ts       # AgentResult / ReviewResult 接口定义
│   ├── ClaudeBridge.ts      # Agent SDK query() 封装 + createChatSession()
│   ├── CodexBridge.ts       # codex exec 子进程封装
│   └── MessageHandler.ts    # 自动应答 AskUserQuestion 处理器
├── utils/
│   ├── AsyncChannel.ts      # Push-to-pull 适配器，为 Agent SDK 提供流式输入
│   ├── cost.ts              # CostTracker (预算守卫)
│   ├── git.ts               # Git 操作 (分支/提交/合并/diff)
│   ├── safeBuild.ts         # 原子 dist/ 替换（自修改安全）
│   └── ...
├── prompts/
│   ├── brain.ts             # Brain 提示词模板 (scan/plan/reflect) + formatDynamicContext
│   ├── executor.ts          # 执行器提示词
│   ├── evaluator.ts         # 执行前评估提示词
│   ├── reviewer.ts          # 审查器提示词
│   ├── agents.ts            # Agent 引导构建器（插件感知）
│   ├── PromptRegistry.ts    # 提示词注册表（缓存 + 动态补丁）
│   └── patchUtils.ts        # 节级补丁工具 (apply/validate)
├── evolution/
│   ├── EvolutionEngine.ts   # 自我进化: 调整/趋势/meta-reflect
│   ├── TrendAnalyzer.ts     # 健康趋势分析
│   └── types.ts             # 进化系统类型
├── memory/
│   ├── TaskStore.ts         # PostgreSQL: 任务/日志/扫描/计划草案/聊天消息/adjustments
│   ├── GlobalMemory.ts      # PostgreSQL: 全局经验记忆
│   └── ProjectMemory.ts     # claude-mem: 项目级记忆
├── mcp/
│   ├── McpDiscovery.ts      # MCP 插件自动发现 + 阶段路由
│   ├── SystemDataMcp.ts     # 内部 MCP 服务器，为 meta-reflect 提供数据查询工具
│   └── InternalMcpServer.ts # 内部 MCP 服务器基类
├── plugins/
│   └── PluginMonitor.ts     # 插件更新监控
├── server/
│   ├── Server.ts            # HTTP 服务（API + 静态文件）
│   └── routes.ts            # REST API 路由 (HttpError 统一错误处理)
├── config/
│   ├── Config.ts            # 配置加载（全局 + 项目级）
│   └── types.ts             # 配置类型定义
├── web/                     # SPA 前端 (HTML/CSS/JS + marked.js Markdown 渲染)
└── scripts/
    └── triggerMetaReflect.ts # 手动触发提示词优化
```

## 快速开始

### 前置要求

- Node.js >= 22
- PostgreSQL（推荐 Docker）
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`@anthropic-ai/claude-agent-sdk`）
- [Codex CLI](https://github.com/openai/codex)（可选，用于双重执行）

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
  "evolution": {
    "metaReflectInterval": 5,
    "promptPatchAutoApply": true,
    "maxActivePromptPatches": 3,
    "goals": [
      { "description": "提升代码质量", "priority": 1, "status": "active" }
    ]
  }
}
```

项目级覆盖：`<project>/.db-coder.json`

### 启动

```bash
# 作为服务运行（相对路径会自动 resolve 为绝对路径）
node dist/index.js serve --project .

# 或指定绝对路径
db-coder serve --project /path/to/your/project

# 生产环境：使用 supervisor 脚本实现自动重启和崩溃恢复
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

Web UI 提供以下功能：

- **仪表盘** — 系统状态、巡逻控制、快捷操作
- **巡逻模式** — 通过顶栏按钮启停巡逻；实时显示状态（扫描中、规划中、执行中等）
- **计划对话** — 与 Claude 多轮对话，实时流式 Markdown 输出；从对话中生成可执行计划
- **任务列表** — 查看、筛选、管理任务，支持分页
- **运行日志** — 实时 SSE 日志流，支持级别过滤
- **系统设置** — 当前项目、系统状态、费用统计、配置查看（只读）

## API

服务运行在 `http://127.0.0.1:18800`，所有 API 需要 Bearer Token 认证。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态（含 projectPath） |
| GET/POST | `/api/tasks` | 任务列表/创建 |
| GET | `/api/tasks/:id` | 任务详情 |
| POST | `/api/control/pause` | 暂停循环 |
| POST | `/api/control/resume` | 恢复循环 |
| POST | `/api/control/scan` | 触发扫描 |
| POST | `/api/patrol/start` | 启动巡逻 |
| POST | `/api/patrol/stop` | 停止巡逻 |
| GET | `/api/logs?follow=true` | SSE 日志流 |
| GET | `/api/memory?q=...` | 搜索记忆 |
| GET | `/api/cost` | 费用详情 |
| **计划对话** | | |
| POST | `/api/plans/chat` | 创建新对话 |
| POST | `/api/plans/:id/message` | 发送用户消息 |
| GET | `/api/plans/:id/messages` | 获取聊天历史 |
| GET | `/api/plans/:id/stream` | SSE 流（实时更新） |
| POST | `/api/plans/:id/generate` | 从对话生成计划 |
| POST | `/api/plans/:id/close` | 关闭对话会话 |
| GET | `/api/plans` | 计划草案列表 |
| POST | `/api/plans/:id/approve` | 审批计划 |
| POST | `/api/plans/:id/reject` | 驳回计划 |
| POST | `/api/plans/:id/execute` | 执行已审批计划 |
| GET | `/api/metrics` | 运维指标（任务统计、费用、健康度） |
| **进化系统** | | |
| GET | `/api/evolution/summary` | 进化摘要 |
| GET | `/api/evolution/prompt-versions` | 提示词版本 |
| POST | `/api/evolution/prompt-versions/:id/activate` | 激活补丁 |
| POST | `/api/evolution/prompt-versions/:id/rollback` | 回滚补丁 |

## 进化反馈环路

DB-Coder 从每次执行结果中持续学习。进化系统连接 执行 → 审查 → 反思 → 未来执行：

```
executeSubtask() ← 注入进化上下文（模式、反模式、调整）
        ↓
  dualReview() → 结构化 mustFix/shouldFix issues
        ↓
  reflectOnTask() ← 丰富的审查详情（不仅是摘要）
        ↓
  processAdjustments() → 因果归因（仅更新被应用的 adjustments）
        ↓
  smartTruncate() → 优先 tool summaries，否则尾部截断
```

核心机制：
- **执行器看到进化上下文**：`synthesizePromptContext()` 将学到的模式、反模式和活跃调整注入每个 executor prompt
- **结构化审查 → 反思**：完整的 `mustFix`/`shouldFix` issue 详情（严重级别、文件、行号、建议）传递到反思，而非仅传摘要字符串
- **因果归因**：记录任务执行时活跃的 adjustment IDs；仅这些 adjustments 在成功/失败时更新 effectiveness
- **智能截断**：优先使用免费的 SDK `tool_use_summary` 元数据；fallback 使用尾部截断（1500 字符）而非头部截断

## Meta-Prompt 反思系统

每完成 N 个任务后，Brain 通过内部 MCP 数据服务器自主分析提示词模板效果并提出优化。

```
任务完成 → 累计计数器 → 触发 metaReflect()
                              ↓
                 SystemDataMcp 提供数据查询工具
                              ↓
                 Brain (Opus) 自主探索数据并提出 0-3 个补丁
                              ↓
              candidate (confidence ≥ 0.7) → active
                              ↓
            effectiveness 追踪（成功 +0.1 / 失败 -0.15）
                              ↓
              effectiveness < -0.3 → 自动回滚
```

**补丁类型**：`prepend` | `append` | `replace_section` | `remove_section`

**安全机制**：
- JSON 格式守卫：验证补丁后提示词仍包含必需的输出格式标记
- 自动回滚：effectiveness < -0.3 且评估 ≥ 3 次
- 通过率回滚：pass rate 下降 > 15% 且评估 ≥ 5 次
- 并发上限：最多 3 个同时活跃的补丁
- 补丁失败降级：返回原始基础模板

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript / Node.js (ESM) |
| 大脑 | Claude Opus，通过 `@anthropic-ai/claude-agent-sdk` |
| 执行器 | Claude Code (Agent SDK) + Codex CLI (`gpt-5.3-codex`) |
| 数据库 | PostgreSQL + `pg_trgm`，通过 `postgres` (porsager) |
| 项目记忆 | claude-mem HTTP API |
| MCP | 自动发现插件（Serena、Context7、Playwright 等） |
| Web UI | 原生 HTML/CSS/JS SPA + marked.js（Markdown 渲染） |
| HTTP 服务 | Node.js `http` 模块 |

## 许可证

MIT
