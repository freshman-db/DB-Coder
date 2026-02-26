# 能力利用改进实施计划

> 基于: capability-analysis.md
> 日期: 2026-02-26
> 目标: 充分发挥 Claude Code + Opus 4.6 能力，优化 Codex 定位

---

## Phase 1: P0 — Extended Thinking + 截断限制

最高影响，最低风险。两个改动独立，可并行实施。

### 1a. 接入 thinking/effort 参数

**背景**: SDK 已支持 `thinking: ThinkingConfig` 和 `effort` 参数，但 db-coder 没有接入。Opus 4.6 的 adaptive thinking 是其最大差异化能力。

**改动文件**:
- `src/bridges/ClaudeCodeSession.ts` — SessionOptions 接口增加字段
- `src/bridges/buildSdkOptions.ts` — 透传到 SDK Options

**SessionOptions 新增字段**:
```typescript
thinking?: import('@anthropic-ai/claude-agent-sdk').ThinkingConfig;
effort?: 'low' | 'medium' | 'high' | 'max';
```

**buildSdkOptions() 新增映射**:
```typescript
if (opts.thinking) options.thinking = opts.thinking;
if (opts.effort) options.effort = opts.effort;
```

**调用点配置**:

| 调用点 | thinking | effort | 理由 |
|--------|----------|--------|------|
| brainThink() | adaptive | high | 决策需要深度推理 |
| workerExecute() | adaptive | medium | 编码任务不需最深推理 |
| workerAnalyze() | adaptive | medium | 方案分析适中即可 |
| ClaudeReviewAdapter | adaptive | medium | 审查聚焦具体问题 |

**验证**: 运行一个完整 cycle，观察大脑决策质量和 token 使用量变化。

---

### 1b. 提高截断限制

**背景**: 当前截断导致 Opus 4.6 的 200k token 上下文窗口仅利用 1-2%，信息大量丢失。

**改动文件**: `src/core/MainLoop.ts`

| 截断点 | 行号 | 当前值 | 新值 | 内容 |
|--------|------|--------|------|------|
| 分析报告 | ~1668 | 12,000 | 40,000 | phase1Result.text.slice() |
| 工人方案 | ~2905 | 10,000 | 30,000 | proposal.slice() in brainSynthesizePlan |
| Code diff (审查决策) | ~3013 | 8,000 | 20,000 | diff.slice() in codeReview/brainReviewDecision |

**风险**: 上下文增大导致成本上升。但 40k chars ≈ 10k tokens，仅占 200k 窗口的 5%，成本影响有限。

**验证**: 对比改动前后大脑决策中是否引用了之前被截断的信息。

---

## Phase 2: P1 — 超时 + 模型路由 + 验证通用化

三个改动有依赖关系：2b 依赖新的 adapter 切换逻辑，2c 独立。

### 2a. 大脑超时调整

**改动文件**: `src/core/MainLoop.ts`

**改动**: `brainThink()` 中 timeout 从 `300_000` (5 min) 改为 `900_000` (15 min)。

**理由**: 大脑的 budget 限制已提供成本保护，超时不应成为思考深度的瓶颈。启用 adaptive thinking 后大脑可能需要更多时间。

---

### 2b. 按复杂度路由执行者

**背景**: S 级任务用 Opus 是浪费。Codex 成本更低且 S 级任务足够。

**改动文件**:
- `src/core/MainLoop.ts` — workerExecuteAndReview 路由逻辑
- `src/core/WorkerAdapter.ts` — 可能需要支持动态切换
- `src/config/types.ts` — COMPLEXITY_CONFIG 扩展

**路由策略**:
```
S  → Codex (full-auto) 执行, Claude (read-only) 审查
M  → Claude Sonnet 执行, Codex (read-only) 审查
L  → Claude Opus 执行, Codex (read-only) 审查
XL → Claude Opus 执行, Codex (read-only) 审查
```

**COMPLEXITY_CONFIG 扩展**:
```typescript
const COMPLEXITY_CONFIG = {
  S:  { maxTurns: 100, maxBudget: 5.0,  timeout: 600_000,   worker: 'codex',  model: undefined },
  M:  { maxTurns: 200, maxBudget: 10.0, timeout: 1_200_000, worker: 'claude', model: 'sonnet' },
  L:  { maxTurns: 200, maxBudget: 15.0, timeout: 2_400_000, worker: 'claude', model: 'opus' },
  XL: { maxTurns: 200, maxBudget: 20.0, timeout: 3_600_000, worker: 'claude', model: 'opus' },
};
```

**实现要点**:
- MainLoop 需要持有两种 worker adapter（Claude + Codex），按复杂度选择
- 审查者自动与执行者互斥（已有逻辑，需从静态选择改为动态选择）
- Codex 执行 S 级任务时不支持 resume，fix 也走 execute（已有逻辑）
- 需要在 `workerExecuteAndReview()` 开头根据 complexity 选择 adapter

**风险**: Codex 执行 S 级任务时没有 MCP 工具和 session resume。如果 S 级任务实际需要这些能力，可能失败。
**缓解**: S 级任务失败后可以自动 fallback 到 Claude 重试（记录失败原因供大脑学习）。

---

### 2c. hardVerify 通用化（自动检测）

**背景**: 当前 hardVerify 仅检查 tsc 错误数，不跑测试，且是 TypeScript 专属。CLAUDE.md 已标注 "hardVerify 依赖 tsc 仍需通用化"。

**改动文件**:
- 新建 `src/core/ProjectVerifier.ts` — 项目类型检测 + 验证执行
- `src/core/MainLoop.ts` — 替换 countTscErrors 调用

**ProjectVerifier 设计**:

```typescript
interface VerifyResult {
  typeCheck: { passed: boolean; errorCount: number; reason?: string };
  test:      { passed: boolean; failCount: number; reason?: string } | null; // null = 无测试
}

class ProjectVerifier {
  detect(projectPath: string): ProjectType;
  baseline(projectPath: string): Promise<VerifyBaseline>;
  verify(projectPath: string, baseline: VerifyBaseline): Promise<VerifyResult>;
}
```

**自动检测优先级**（从上到下，命中即停）:

| 检测条件 | 项目类型 | 类型检查命令 | 测试命令 |
|---------|---------|------------|---------|
| `tsconfig.json` 存在 | TypeScript | `npx tsc --noEmit` | `npm test`（需 package.json 有 test script 且不是默认占位） |
| `package.json` 存在（无 tsconfig） | JavaScript/Node | — | `npm test`（同上） |
| `go.mod` 存在 | Go | `go vet ./...` | `go test ./...` |
| `Cargo.toml` 存在 | Rust | `cargo check` | `cargo test` |
| `pyproject.toml` 或 `setup.py` 存在 | Python | — | `pytest`（检查 pytest 可用） |
| `Makefile` 含 `test:` target | 通用 | — | `make test` |
| 以上都不命中 | Unknown | — | — |

**npm test 占位检测**: package.json 的 test script 如果是 `echo \"Error: no test specified\" && exit 1`（npm init 默认值），视为无测试，跳过。

**baseline/compare 模式**:
1. 任务开始前: `baseline()` 记录当前类型检查错误数 + 测试失败数
2. 任务完成后: `verify()` 重新运行，对比
3. 规则: 错误数/失败数不能增加（与 tsc 现有逻辑一致）
4. 命令不存在或项目无测试: 跳过对应检查，不阻塞

**超时保护**: 测试命令加 timeout（默认 120s），超时视为 skip 并 warn，不阻塞验证。

---

## Phase 3: P2 — 提示词优化

低风险，可逐步 A/B 验证。

### 3a. 简化 brainDecide 提示词

**改动文件**: `src/core/MainLoop.ts` (~line 1627-1637)

**当前**: 10 个维度清单 + 3 个自我批判方式选择
**改为**:

```
## YOUR MISSION
Find the highest-value improvement opportunities in this project.
You have full freedom to explore the codebase and decide what matters most.

Prioritize improvements that are:
- High impact on correctness, reliability, or maintainability
- Low risk of breaking existing functionality
- Verifiable (can be validated by tsc + tests + code review)

Think deeply. You are not constrained to any predefined category.
```

**保留**: 上下文注入（queued tasks, recent tasks, budget, hot files）不变。

---

### 3b. 去掉审查数量限制

**改动文件**: `src/core/MainLoop.ts`

| 行号 | 当前文本 | 改为 |
|------|---------|------|
| ~2678 | "Find 3-10 specific issues..." | "Report all issues you find. If the code is clean, report passed: true with an empty issues array." |
| ~3213 | "Find 3-10 specific issues..." | 同上 |

---

### 3c. 去掉 persona 系统

**背景**: Claude Code 的 `preset: 'claude_code'` 已建立完整的 agent 身份和能力。在上面叠加 "You are a refactoring-expert" 等 persona 是在缩窄内置 prompt 的能力范围。大脑输出的 `workInstructions`（acceptanceCriteria、filesToModify、guardrails）已经比角色标签更精确地指导工人行为。

**改动文件**:
- `src/core/PersonaLoader.ts` — 简化 buildWorkerPrompt()，移除 persona 注入
- `src/core/MainLoop.ts` — 移除 persona 选择/统计逻辑

**改动内容**:
- `appendSystemPrompt` 不再注入 "You are a [role]." + persona 内容
- 保留 `GLOBAL_WORKER_RULES`（自主 agent 规则 + pre-commit checklist）
- 保留 work instructions 注入（acceptanceCriteria 等）
- 移除 brainDecide 输出中的 persona 字段（改为可选，不影响执行）
- 移除 brainReflect 中的 persona 统计更新逻辑

**风险**: 低。移除约束而非增加约束，work instructions 已提供足够的任务聚焦。

---

## 实施顺序和依赖

```
Phase 1a (thinking/effort) ──┐
                              ├── 可并行 ──→ Phase 2a (超时) ──→ Phase 2b (模型路由)
Phase 1b (截断限制)     ──────┘                                        │
                                                                       ↓
Phase 2c (验证通用化) ── 独立，可与 2a/2b 并行 ─────────────────→ Phase 3 (提示词)
```

**建议执行顺序**:
1. **Sprint 1**: Phase 1a + 1b 并行（改动小，风险低，效果立竿见影）
2. **Sprint 2**: Phase 2a + 2c 并行（超时是一行改动，验证通用化独立）
3. **Sprint 3**: Phase 2b（模型路由，改动最大，需要新的 adapter 切换逻辑）
4. **Sprint 4**: Phase 3a + 3b + 3c（提示词优化 + 去掉 persona）

## 验证策略

每个 Phase 完成后运行 3-5 个完整 cycle，对比：
- 大脑决策质量（是否引用了更多上下文信息）
- 任务成功率
- 日均成本
- 审查通过率
- 超时/截断发生率
