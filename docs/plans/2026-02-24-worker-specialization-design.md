# Worker 专业化重构设计

## 概述

重构 worker 执行流程，引入 Persona + Skill + Subtask 三层体系，解决当前所有任务使用同一 worker profile 的问题。

借鉴来源：
- **BMAD-METHOD**：Agent-as-Code (角色外部化)、Epic Sharding (任务拆分)
- **Superpowers**：Skill 系统 (方法论注入)、Subagent-driven-development (独立 session + 两阶段审查)

两个项目均为"借鉴思路"而非直接集成。

---

## 一、Persona 系统

### 目标

不同任务类型使用不同 worker 角色，每个角色有专业的身份定位、工作原则和质量门禁。

### 存储：数据库 + Seed 文件

Seed 文件（版本控制）：
```
personas/
  feature-builder.md
  refactoring-expert.md
  bugfix-debugger.md
  test-engineer.md
  security-auditor.md
  performance-optimizer.md
  frontend-specialist.md
  _template.md
```

数据库表：
```sql
CREATE TABLE personas (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,          -- Markdown 格式的 persona 正文
  task_types TEXT[] DEFAULT '{}', -- 适用的任务类型
  focus_areas TEXT[] DEFAULT '{}',-- 关注维度
  usage_count INT DEFAULT 0,
  success_rate FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

启动时从 seed 文件加载（不覆盖已存在的记录）。Brain 反思时可通过 API 更新 persona 内容。

### Persona 格式（Seed 文件）

```markdown
---
name: refactoring-expert
role: Senior Refactoring Engineer
taskTypes: [refactoring, code-quality]
focusAreas: [code-quality, architecture, maintainability]
---

## Identity
You are a refactoring specialist. You restructure code for clarity
and maintainability without changing behavior.

## Principles
- Never change behavior — refactoring is structure-only
- Verify: tests must pass before AND after every change
- Smallest possible commits — one concern per commit
- Measure complexity reduction (function length, nesting depth)

## Quality Gates
- All existing tests still pass
- No new tsc errors introduced
- Functions > 80 lines must be split
- Nesting depth ≤ 3 levels
```

### Brain 选择 Persona

Brain 输出的 JSON 扩展 `persona` 字段：
```json
{"task": "...", "priority": 2, "persona": "refactoring-expert", "taskType": "refactoring", "reasoning": "..."}
```

PersonaLoader 从 DB 读取对应 persona 的 `content` 字段，注入 worker session 的 `appendSystemPrompt`。

---

## 二、Skill 系统

### 目标

根据任务类型注入工作方法论（TDD、调试、安全审查等），确保 worker 遵循结构化流程。

### 架构：自定义 Skill + Claude Code 原生机制调用

自定义 skill 放在 `.claude/skills/` 目录，Claude Code 自动发现：
```
.claude/skills/
  db-coder-security-review/
    SKILL.md
  db-coder-perf-optimization/
    SKILL.md
  db-coder-feature-impl/
    SKILL.md
```

已安装的 superpowers 插件提供内置 skill：
- `superpowers:test-driven-development`
- `superpowers:systematic-debugging`
- `superpowers:verification-before-completion`

Worker session 作为 `claude -p` 子进程，session-start hook 触发时自动加载 skill 系统。

### 任务类型到 Skill 映射

| 任务类型 | 主 Skill | 辅助 Skill |
|---------|---------|-----------|
| feature | superpowers:test-driven-development | superpowers:verification-before-completion |
| bugfix | superpowers:systematic-debugging | superpowers:verification-before-completion |
| refactoring | superpowers:verification-before-completion | — |
| test | superpowers:test-driven-development | — |
| security | db-coder-security-review | superpowers:verification-before-completion |
| performance | db-coder-perf-optimization | superpowers:verification-before-completion |

### Worker Prompt 结构

```
你是 {persona.role}。

{persona.content}

执行任务: {task.description}

使用以下技能完成工作:
- {skill_1}
- {skill_2}

Read CLAUDE.md for project context. Do NOT modify CLAUDE.md.
Commit with a descriptive message.
```

---

## 三、Subtask 拆分与执行

### 目标

复杂任务由 Brain 拆成子任务，每个子任务用独立 worker session 执行，防止 context 膨胀和跑偏。

### Brain 输出格式（复杂任务）

```json
{
  "task": "重构 MainLoop 的 runCycle 方法",
  "priority": 2,
  "persona": "refactoring-expert",
  "taskType": "refactoring",
  "subtasks": [
    {"description": "提取 git 分支管理逻辑到独立方法", "order": 1},
    {"description": "提取验证+审查流程到独立方法", "order": 2},
    {"description": "提取合并/清理逻辑到独立方法", "order": 3}
  ],
  "reasoning": "runCycle 250行太长，拆成3步，每步独立可验证"
}
```

简单任务无 `subtasks` 字段，走当前的单次执行流程。

### 执行流程

```
if (subtasks):
  for each subtask in order:
    1. 创建独立 Worker session (persona + skills + subtask.description)
    2. hardVerify() — tsc 错误计数对比
    3. if failed → workerFix(resumeSession) → re-verify
    4. commit subtask 结果
  end for
  → 进入两阶段审查
else:
  当前单次 workerExecute 流程 (不变)
  → 进入两阶段审查
```

### 关键设计决策

1. **独立 session**：每个 subtask 用 fresh ClaudeCodeSession，防止 context 污染
2. **逐步 commit**：每个 subtask 完成后 commit，便于 rollback 和审查
3. **失败策略**：单个 subtask 失败 → workerFix 尝试修复 → 仍失败 → 整个 task 标记 blocked

---

## 四、两阶段审查

### 目标

在 hardVerify (tsc) 基础上，增加 Spec 合规审查，与现有 Codex 审查形成两阶段验证。

### 审查流程

```
Per-subtask:  hardVerify (tsc 错误计数对比)
              ↓
Whole task:   Stage 1 — Spec Compliance Review (Brain session)
              ↓ (通过后)
              Stage 2 — Code Quality Review (Codex CLI, 保留现有逻辑)
              ↓
              merge/discard
```

### Stage 1 — Spec 合规审查（新增）

使用 Brain session，只读模式：
- 输入：原始 task description + subtasks 定义 + 实际 git diff
- 独立判断：实现是否完整覆盖需求
- **关键原则**：不信任 worker 的 commit message，只看实际代码
- 输出：
```json
{
  "passed": true/false,
  "missing": ["未实现的需求"],
  "extra": ["超出范围的变更"],
  "concerns": ["潜在问题"]
}
```

### Stage 2 — 代码质量审查（保留）

现有 Codex 审查逻辑不变。只在 Stage 1 通过后执行（节省成本）。

### 合并决策

```
shouldMerge = hardVerify.passed && specReview.passed && codexReview.passed
```

---

## 五、需要变更的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `personas/*.md` | 新增 | 6-8 个 persona seed 文件 |
| `.claude/skills/db-coder-*/SKILL.md` | 新增 | 2-3 个自定义 skill |
| `src/core/PersonaLoader.ts` | 新增 | 读取 DB persona + seed 加载逻辑 (~80行) |
| `src/core/MainLoop.ts` | 修改 | brainDecide 输出格式、workerExecute 支持 persona/subtask、新增 specReview 方法 |
| `src/bridges/CodingAgent.ts` | 修改 | 扩展接口增加 persona/subtasks 字段 |
| `src/memory/TaskStore.ts` | 修改 | 新增 personas 表 CRUD |
| `src/server/routes.ts` | 修改 | 新增 persona API 端点 |

### 不变的部分

- `ClaudeCodeSession` — 无需改动
- `hardVerify` — 无需改动
- `CodexBridge` — 无需改动
- Git 分支管理 — 无需改动
- Web UI 核心 — 无需改动（可后续增加 persona 管理页面）
- 数据库 tasks 表 — `subtasks` JSONB 字段已存在

---

## 六、数据流概览

```
┌──────────────────────────────────────────────────────────────┐
│                     MainLoop.runCycle()                       │
│                                                              │
│  Brain Decide                                                │
│    → task + persona + taskType + subtasks?                   │
│                                                              │
│  PersonaLoader.load(persona)                                 │
│    → DB 查询 → 返回 persona content                         │
│                                                              │
│  if subtasks:                                                │
│    for each subtask:                                         │
│      Worker session (                                        │
│        appendSystemPrompt = persona content,                 │
│        prompt = subtask + skills                             │
│      ) → execute → hardVerify → commit                      │
│  else:                                                       │
│    Worker session (persona + task) → execute                 │
│                                                              │
│  Stage 1: Brain Spec Review (diff vs requirements)           │
│  Stage 2: Codex Quality Review (保留现有逻辑)                │
│                                                              │
│  Brain Reflect → 学习 + 可进化 persona                      │
│  Merge or Discard                                            │
└──────────────────────────────────────────────────────────────┘
```
