# Claude Code + Opus 4.6 能力利用分析

> 分析日期: 2026-02-26
> 范围: db-coder 编排器的提示词、流程、约束是否充分发挥了 Claude Code 和 Opus 4.6 的能力

---

## 目前做得好的地方

**1. 大脑/工人分离架构** — Opus 做只读决策，工人做执行。符合 Opus 4.6 "深度推理" 的定位。大脑不碰文件，消除了决策层的副作用风险。

**2. Session resume + prompt caching** — 两阶段 brainDecide（探索→结构化输出）复用 session，利用了 prompt caching 节省成本并保持上下文连续。

**3. MCP 阶段路由** — 按 scan/plan/execute/review 阶段分配 MCP 服务器，减少工具噪声，让每个阶段只看到需要的工具。

**4. 工人/审查互斥** — Claude 写代码时 Codex 审查（或反过来），不同模型族的交叉验证消除了自我验证偏差。

**5. 结构化输出 fallback 链** — JSON schema → 文本提取 JSON → 原始文本，多层降级保证鲁棒性。

---

## 正在限制能力发挥的问题

### P0: 关键限制

#### 1. 没有配置 Extended Thinking（思维链预算）

`buildSdkOptions.ts` 没有传递 `thinkingBudget`。Extended thinking 是 Opus 4.6 最大的差异化能力 — 允许模型在回复前花最多 128k token 做深度推理。大脑的探索、审查决策、反思阶段都是最适合深思的场景，但目前没有显式启用。

**影响**: 大脑的决策质量未达到 Opus 4.6 的天花板。

**建议**: 给大脑 session 配置 `thinkingBudget: 10000-30000`，按阶段调整：
- brainDecide 探索: 30000（需要深度分析）
- brainReviewDecision: 20000（权衡多个选项）
- brainReflect: 10000（总结性质，不需太多）

#### 2. 上下文截断过于激进

| 截断点 | 当前限制 | Opus 4.6 上下文窗口 | 利用率 |
|--------|---------|-------------------|--------|
| 分析报告 | 12,000 chars (~3k tokens) | 200k tokens | 1.5% |
| 工人方案 | 10,000 chars (~2.5k tokens) | 200k tokens | 1.25% |
| Code diff (审查决策) | 8,000 chars (~2k tokens) | 200k tokens | 1% |
| 课题摘要 | 200 chars | — | — |

大脑在 Phase 1 可能发现了细致的架构问题，但 12k 截断让 Phase 2 看不到完整分析。Code review 8k diff 限制意味着大型变更的审查决策基于不完整信息。

**建议**: 提高截断限制 — analysis: 40k chars, proposal: 30k chars, diff: 20k chars。仍然远低于上下文上限，但信息损失大幅减少。

### P1: 重要限制

#### 3. 大脑 5 分钟超时对 Opus 太短

Opus 4.6 的强项是深度推理，需要时间。5 分钟做代码库探索 + 10 维度分析 + 自我批判，很可能经常超时或被迫草率结论。特别是对新项目或大型代码库的首次扫描。

**建议**: 大脑超时提到 10-15 分钟。budget 限制已经提供了成本保护，超时不应成为思考深度的瓶颈。

#### 4. Worker 默认用 Opus，浪费预算

Config 默认 `claude.model: "opus"`。S 级任务（简单 bug fix, 小 refactor）用 Opus 是杀鸡用牛刀。Sonnet 4.6 的编码能力几乎与 Opus 持平，成本低 5-10x。

**建议**: 按复杂度自动选模型：
- **大脑**: 永远 Opus（决策需要深度推理）
- **工人 S/M 任务**: Sonnet 4.6（编码能力足够，成本低）
- **工人 L/XL 任务**: Opus 4.6（复杂任务需要深度理解）

#### 5. hardVerify 只检查 tsc，不跑测试

提示词告诉工人 "run tsc and tests before your final commit"，但编排器只验证 tsc 错误数（`countTscErrors()`）。如果工人引入了通过 tsc 但破坏测试的变更，hardVerify 不会拦住。

**建议**: hardVerify 增加 `npm test` 结果验证。测试通过/失败是比 tsc 更强的质量信号。

### P2: 中等限制

#### 6. 提示词过于结构化，限制了涌现能力

brainDecide 提示词列出了 10 个扫描维度（功能完善、功能增强、模块深度扫描...）和 3 个自我批判方式。这像是在指挥一个弱模型按清单执行。

Opus 4.6 的能力是**自主发现问题** — 不需要告诉它看什么。清单限制了 Claude 发现那些不在清单上的问题（如架构设计缺陷、抽象泄漏、跨模块一致性问题、技术债的系统性模式）。

**建议**: 简化为目标导向的提示词：
```
找到这个项目最高价值的改进机会。
你有完全的自由度去探索代码库，判断什么最重要。
优先考虑：影响大、风险低、可验证的改进。
```

#### 7. 没有利用 Claude Code 的内置 Plan Mode

系统重新实现了 plan mode（workerAnalyze → reviewPlan → brainSynthesizePlan）。Claude Code 内置的 `EnterPlanMode` → `ExitPlanMode` 流程已经做了类似的事，探索→规划→确认流程更成熟，且集成了 Claude Code 自身的工具链。

**建议**: 评估是否可以让工人在 plan mode 下做分析阶段，减少编排器的复杂度。

#### 8. Persona 系统可能窄化工人视角

```
"You are a refactoring-expert."
```

研究表明 persona prompting 对强模型的效果有限甚至有害 — 它可能让模型过度聚焦 persona 定义的行为，忽略 persona 外的重要事项（如 refactoring-expert 可能忽略安全问题）。Opus 4.6 自身已经具备多角度分析能力。

**建议**: 评估去掉 persona 系统，改为在 work instructions 中描述具体目标和约束。对比有/无 persona 的任务完成质量。

#### 9. 审查提示词 "find 3-10 specific issues" 有数量偏差

告诉审查者 "找 3-10 个问题" 会导致：
- 完美代码也被挑出 3 个低质量问题（凑数）
- 有 20 个问题时只报 10 个（遗漏）

**建议**: 改为 "报告所有你发现的问题，无论数量。如果没有发现问题，报告 passed: true"。

---

## 改进优先级汇总

| 优先级 | 改动 | 涉及文件 | 预期效果 |
|--------|------|---------|---------|
| P0 | 配置 thinkingBudget | buildSdkOptions.ts, MainLoop.ts | 决策质量大幅提升 |
| P0 | 提高截断限制 (40k/30k/20k) | MainLoop.ts | 信息不再丢失 |
| P1 | 大脑超时提到 10-15 分钟 | MainLoop.ts | 允许深度探索 |
| P1 | 工人模型按复杂度选择 | MainLoop.ts, Config.ts | 日成本降低 50%+ |
| P1 | hardVerify 加入 npm test | MainLoop.ts | 捕获更多回归 |
| P2 | 简化 brainDecide 提示词 | MainLoop.ts | 释放涌现能力 |
| P2 | 评估内置 Plan Mode | MainLoop.ts, WorkerAdapter.ts | 减少编排复杂度 |
| P2 | 评估去掉 persona | PersonaLoader.ts | 减少复杂度 |
| P2 | 去掉审查数量限制 | MainLoop.ts | 审查质量更真实 |

---

## Codex CLI + GPT-5.3-Codex 定位分析

### 当前使用方式

默认配置下（`autonomy.worker: "claude"`），Codex 仅作为**代码审查者**，Claude Code 做执行。这是合理的默认选择，但没有充分利用 Codex 的优势。

### Codex 的核心特性

| 特性 | Codex CLI | Claude Code |
|------|-----------|-------------|
| 沙箱隔离 | 内置 3 级（read-only / workspace-write / full-auto） | 权限系统 + disallowedTools |
| Session 状态 | 无状态（每次独立） | 有状态（支持 resume） |
| 并发执行 | 天然适合（无状态无冲突） | 需要独立 session 实例 |
| 成本 | input $1.75/M, output $14/M | Opus 显著更贵 |
| 推理深度 | GPT-5.3 级别 | Opus 4.6 级别（更深） |
| 工具生态 | CLI 工具链 | MCP + 插件 + CLAUDE.md |
| 上下文窗口 | 大 | 200k tokens |

### Codex 比 Claude Code + Opus 4.6 更适合的场景

#### 1. 代码审查（当前用法） — 优势明确

- **不同模型族 = 不同视角**: GPT 系和 Claude 系的训练数据、偏差模式不同。交叉审查能发现单一模型家族内的盲区。
- **无状态足够**: 审查不需要上下文累积，每次给 diff + 上下文即可。
- **沙箱天然适配**: `read-only` 模式硬保证审查者不能修改代码。
- **成本合理**: 审查是高频操作，Codex 的定价更可控。

#### 2. S 级简单执行任务 — 值得启用

- **简单 bug fix、typo 修复、单文件重构**: 不需要 Opus 的深度推理，GPT-5.3-Codex 完全胜任。
- **成本优势显著**: 一个 S 级任务可能只需 $0.5-1.0（Codex） vs $2-5（Opus）。
- **全自动沙箱**: `--full-auto` 模式提供了比 Claude Code `bypassPermissions` 更明确的权限边界。

#### 3. 批量并行任务 — 天然适配

- **无状态**: 多个 Codex 进程可以并行执行互不相关的任务，不存在 session 冲突。
- **适用场景**: 多个独立的 lint 修复、多个文件的格式统一、批量添加 JSDoc。
- **Claude Code 的限制**: 多 session 需要更复杂的管理（独立实例、端口冲突等）。

#### 4. 沙箱实验 — 安全边界更强

- **探索性代码生成**: 让 Codex 在 `workspace-write` 沙箱中尝试实现，失败了丢弃即可。
- **不信任的任务**: 对可能产生危险操作的任务，Codex 的沙箱比 Claude Code 的权限系统提供更强的隔离。

### Claude Code + Opus 4.6 不可替代的场景

#### 1. 大脑决策层 — Opus 独占

- Extended thinking 的深度推理
- 跨 session resume 的上下文连续性
- 复杂权衡（fix vs ignore vs block vs rewrite vs split）
- 代码库全局理解

#### 2. L/XL 复杂任务执行 — Opus 优势大

- 多文件协调修改（需要全局理解）
- 架构级重构（需要理解设计意图）
- 跨模块集成（需要追踪调用链）
- 涉及 MCP 工具的任务（Codex 无 MCP 生态）

#### 3. 方案分析阶段 — Claude Code 更强

- Plan Mode 集成
- MCP 服务器（serena, context7）提供语义级代码理解
- Session resume 允许多轮深化分析

#### 4. 反思和进化 — Opus 独占

- 需要理解任务上下文 + 历史 + persona 的复合推理
- claude-mem 记忆系统集成
- CLAUDE.md 维护

### 推荐的混合策略

```
任务复杂度    执行者              审查者              理由
─────────────────────────────────────────────────────────────
S            Codex (full-auto)   Claude (read-only)  成本低，简单任务足够
M            Claude (sonnet)     Codex (read-only)   需要 MCP + 上下文
L            Claude (opus)       Codex (read-only)   需要深度理解
XL           Claude (opus)       Codex (read-only)   需要深度理解 + 长上下文

方案审查      Codex (read-only)   —                  不同视角审查方案
代码审查      Codex (read-only)   —                  不同视角审查代码
批量修复      Codex (并行多实例)   Claude (抽样)       高吞吐 + 抽样质量控制
```

### 实现路径

1. **短期**: 保持当前默认（Claude 执行 + Codex 审查），但在 Config 中支持按复杂度自动切换工人
2. **中期**: S 级任务自动路由到 Codex 执行，Claude 审查；M+ 任务保持 Claude 执行
3. **长期**: 支持批量并行 Codex 执行（如一次性修复 10 个 lint 问题），Claude 做抽样审查

---

## 一句话总结

**架构设计（大脑/工人分离、互斥审查、方案阶段）是优秀的**，但在利用 Opus 4.6 的核心能力（extended thinking、大上下文、自主发现）上有明显不足。修复 P0 问题（思维链预算 + 截断限制）会带来最大的质量提升。Codex 当前作为审查者是正确的定位，但可以进一步扩展到 S 级任务执行和批量并行场景，实现更优的成本-质量平衡。
