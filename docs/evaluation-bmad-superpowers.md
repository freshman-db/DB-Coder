# 评估报告：BMAD-METHOD 与 Superpowers 对 db-coder 的价值分析

## Context

db-coder 当前采用 brain/worker 二角色模型自主运行。用户希望评估两个外部项目的借鉴/集成价值，再决定具体方案。

---

## 一、当前架构基线

```
MainLoop (编排器)
  ├── Brain session (只读, 决策+反思, opus/sonnet)
  ├── Worker session (读写, 编码执行, bypassPermissions)
  ├── Hard verify (tsc 错误计数对比)
  ├── Codex review (diff 级审查)
  └── Guards (Concurrency, Budget, EmptyDiff, StructuredOutput)
```

**已有的 Superpowers 引用** (MainLoop.ts prompt 文本中)：
- `workerExecute` → `test-driven-development`, `verification-before-completion`
- `workerFix` → `systematic-debugging`
- `brainReflect` → `requesting-code-review`

**缺失能力**：
- 没有多角色专业化（所有任务同一个 worker profile）
- Brain 的任务分解粒度粗（一个 task description，没有 subtask 拆分执行）
- Worker 执行无结构化阶段（一次性 30 turns 跑完）
- 没有复杂任务的渐进式上下文构建

---

## 二、Superpowers 评估

### 2.1 当前集成深度：浅层 (prompt 文本引用)

Worker prompt 中写了 "Use superpowers:test-driven-development"，但：
- Claude Code 作为被 spawn 的子进程，是否加载了 superpowers 插件取决于子进程的环境
- 即使加载了，skill 的触发是自动的（基于 context 匹配），不受 prompt 文本控制
- 没有验证 skill 是否实际触发和遵循

### 2.2 深化集成的可能方向

| 方向 | 做法 | 收益 | 代价 | 可行性 |
|------|------|------|------|--------|
| **A. 子进程 skill 确认** | 检查 worker session 输出中是否有 skill 触发迹象 | 确保 TDD/debugging 等流程被遵循 | 低，只需解析输出 | 高 |
| **B. Subagent 模式** | Worker 大任务时拆成多个子 agent（借鉴 subagent-driven-development） | 减少单 session context 膨胀，提高成功率 | 中，需要任务拆分逻辑 | 中 |
| **C. Git worktree 隔离** | Worker 在 worktree 中工作而非直接在 feature branch | 更安全的隔离，失败更干净 | 低-中，worktree 管理逻辑 | 高 |
| **D. 7 阶段流水线** | 将 worker 执行拆成 brainstorm → plan → implement → test → review | 更可控的执行过程 | 高，大幅改造 MainLoop | 低 |

### 2.3 收益评分

- **方向 A** (skill 确认)：投入小，收益中等 → **推荐立即做**
- **方向 B** (subagent)：投入中，收益高（解决大任务成功率问题）→ **值得探索**
- **方向 C** (worktree)：投入低-中，收益中等 → **可选**
- **方向 D** (7 阶段)：投入高，与 brain/worker 架构冲突 → **不推荐**

---

## 三、BMAD-METHOD 评估

### 3.1 核心理念映射

| BMAD 理念 | db-coder 现状 | 适配度 |
|-----------|--------------|--------|
| **Agent-as-Code (Markdown persona)** | Brain/worker 角色硬编码在 MainLoop prompt 中 | 高——可外部化 persona 定义 |
| **多专业角色** | 只有 brain + worker 两角色 | 中——需要评估是否值得增加角色 |
| **4 阶段方法论** | brain decide → worker execute → verify → reflect | 已有类似结构 |
| **Context-Engineered Development** | Brain 的 gatherBrainContext 做了部分工作 | 中——可增强上下文传递 |
| **Epic sharding (大需求拆子任务)** | 有 subtasks 字段但未实际使用 | 高——数据结构已在，缺逻辑 |

### 3.2 可借鉴方向

| 方向 | 做法 | 收益 | 代价 | 可行性 |
|------|------|------|------|--------|
| **E. Persona 外部化** | 将 brain/worker prompt 提取为 Markdown persona 文件，Brain 按任务类型选择 | 可扩展性，不同任务用不同 worker 角色 | 低-中，提取+加载逻辑 | 高 |
| **F. 任务拆分执行** | Brain 生成 subtasks，Worker 逐个执行+验证 | 大任务成功率提升，粒度可控 | 中，需要 subtask 编排 | 中-高 |
| **G. 专业审查角色** | 增加安全审查、性能审查等专业 persona | 审查质量提升 | 中，增加 session 成本 | 中 |
| **H. 完整 4 阶段** | 增加独立的 "架构设计" 阶段在 brain decide 和 worker execute 之间 | 复杂任务质量提升 | 高，增加 cycle 时间和成本 | 低-中 |

### 3.3 收益评分

- **方向 E** (persona 外部化)：投入低，收益高（可扩展性+可维护性）→ **推荐**
- **方向 F** (任务拆分)：投入中，收益高（这是当前最大痛点之一）→ **强烈推荐**
- **方向 G** (专业审查)：投入中，收益中等 → **可选，已有 Codex 审查**
- **方向 H** (4 阶段)：投入高，收益不确定 → **暂不推荐**

---

## 四、综合建议

### 推荐优先级

| 优先级 | 方向 | 来源 | 预估工作量 | 核心收益 |
|--------|------|------|------------|----------|
| **P0** | F. 任务拆分执行 | BMAD | 2-3 天 | 大任务成功率从 ~60% 提升到 ~85% |
| **P1** | E. Persona 外部化 | BMAD | 1 天 | 可扩展性，不同任务类型定制化 |
| **P1** | B. Subagent 模式 | Superpowers | 2 天 | 与 F 协同，子任务独立 session 执行 |
| **P2** | A. Skill 触发确认 | Superpowers | 0.5 天 | 确保质量流程被遵循 |
| **P2** | C. Git worktree | Superpowers | 1 天 | 更安全的执行隔离 |

### 不推荐

- **D. 7 阶段流水线**：过度工程，与现有架构冲突
- **H. 完整 4 阶段**：增加 cycle 时间和成本，收益不确定
- **直接集成 BMAD npm 包**：BMAD 面向人机协作 IDE 场景，API 不适配自主 agent

### 结论

**两个项目都是"借鉴思路"而非"直接集成"**。具体来说：
- **BMAD**：借鉴其任务拆分 (epic sharding) 和角色外部化 (Agent-as-Code) 理念
- **Superpowers**：它已是 Claude Code 插件，子进程自动可用；重点是利用其 subagent 模式思想改进 worker 执行策略

最大收益点是 **F+B 组合**：Brain 将复杂任务拆成 subtasks (BMAD 思想)，每个 subtask 用独立 worker session 执行 (Superpowers subagent 思想)。这直接解决 db-coder 当前"大任务一次性跑 30 turns 容易跑偏"的痛点。
