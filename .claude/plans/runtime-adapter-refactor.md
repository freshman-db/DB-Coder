# 重构计划：多运行时解耦 + 大脑认知解放

## 设计原则

**把护栏从思考内部，退回到系统边界。**

编排器不做认知微操，只保留角色 framing、安全边界和输出契约。
具体职责：权限、预算上限、状态机、验证、回滚、审计。

## 两条并行线

```
线 A: RuntimeAdapter — phase→runtime→model 三层解耦
线 B: Brain-driven  — 大脑从"任务发现器"升级为"技术负责人"
```

两条线独立实施但互相增强：A 解锁多模型能力，B 解放模型认知。

---

# 线 A：RuntimeAdapter 多运行时解耦

## 目标

每个阶段 (brain/plan/execute/review/reflect/scan) 可独立选择 runtime + model。
系统能力天花板 = 最强可用模型的能力。

## 当前问题

| 绑定点 | 位置 | 问题 |
|--------|------|------|
| 大脑硬绑 Claude SDK | MainLoop:161, BrainPhase:124 | brainSession = new ClaudeCodeSession()，不走任何抽象 |
| ChainScanner 硬绑 | ChainScanner:311 | 构造参数是 ClaudeCodeSession 具体类型 |
| Worker name 枚举 | WorkerAdapter:59 | `"claude" \| "codex"` 写死 |
| 模型别名降级 | Config:186-193 | resolveModelId() 只认 opus/sonnet，其他回落 sonnet |
| Codex model 不透传 | CodexBridge 全文 | 没有 --model 参数 |
| 复杂度路由绑 Claude | WorkerPhase:49-54 | S/M→sonnet, L/XL→opus 硬编码 |
| SdkExtras 仅 Claude | buildSdkOptions.ts | hooks/plugins/MCP 只有 Claude 能用 |
| RoutingConfig 写死 | types:48-54 | 字面量类型 `"brain" \| "claude" \| "codex"` |
| CLAUDE_MEM_MODEL 硬编码 | buildSdkOptions:21 | 写死 claude-opus-4-6 |

## 核心接口

```typescript
// src/runtime/RuntimeAdapter.ts

interface RuntimeCapabilities {
  nativeOutputSchema: boolean;     // 原生 JSON schema / outputSchema（vs 文本解析 fallback）
  eventStreaming: boolean;         // 流式文本/事件回调
  sessionPersistence: SessionPersistenceCapability;  // session resume（见下方说明）
  sandboxControl: boolean;         // 原生只读/沙箱模式（vs prompt 约束）
  toolSurface: boolean;            // 工具控制：allowedTools/disallowedTools/hooks/plugins/MCP
  extendedThinking: boolean;       // 扩展思考 + effort（目前仅 Claude）
}

/**
 * Session persistence 是条件化能力——不同 runtime 支持程度不同。
 * 单个布尔值无法表达"仅在 full-auto sandbox 下才能 resume"这类约束。
 */
type SessionPersistenceCapability =
  | false                          // 完全不支持
  | true                           // 无条件支持（Claude SDK）
  | { conditional: string };       // 有条件支持，string 描述限制条件

// 实例：
// ClaudeSdkRuntime:  sessionPersistence: true
// CodexSdkRuntime:   sessionPersistence: true
// CodexCliRuntime:   sessionPersistence: { conditional: "sandbox=full-auto" }

// 编排器使用方式：
// if (cap.sessionPersistence === true) → 传 resumeSessionId，runtime 直接 resume
// if (cap.sessionPersistence === false) → 不传 resumeSessionId，用完整 prompt
// if (typeof cap.sessionPersistence === 'object') → 编排器仍然传 resumeSessionId，
//   由 runtime 在 run() 内部判定当前条件是否满足：
//   - 满足 → 执行 resume
//   - 不满足 → 忽略 resumeSessionId，自动降级为完整 prompt，log.info 说明原因
//
// 关键决策：条件判定在 runtime 内部完成，不暴露 canResume() 到接口。
// 理由：条件逻辑是 runtime 实现细节（如 Codex CLI 的 sandbox 模式），
//       编排器不应关心具体条件，只需知道"这个 runtime 的 resume 可能不总是生效"。

interface RunOptions {
  cwd: string;
  model?: string;              // 全量透传
  timeout?: number;
  maxTurns?: number;
  maxBudget?: number;
  systemPrompt?: string;
  outputSchema?: object;
  readOnly?: boolean;
  resumeSessionId?: string;
  resumePrompt?: string;
  thinking?: object;
  effort?: string;
  onText?: (text: string) => void;
}

interface RunResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  numTurns?: number;
  isError: boolean;
  errors: string[];
}

interface RuntimeAdapter {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  run(prompt: string, opts: RunOptions): Promise<RunResult>;
  isAvailable(): Promise<boolean>;
  /** 判定该 runtime 是否支持指定 model（用于 resource_request.model 路由） */
  supportsModel(modelId: string): boolean;
}
```

## Runtime 实现

### Claude 家族

| Runtime | 包装 | capabilities |
|---------|------|-------------|
| ClaudeSdkRuntime | ClaudeCodeSession + Agent SDK | 全能：所有 capability = true |

### Codex 家族

**重要关系**：Codex SDK 是 Codex CLI 的 programmatic wrapper（官方 README: "TypeScript SDK wraps
the codex CLI"），不是独立的运行时底座。两者共享同一个执行引擎和信任边界。

因此建模为**同一 runtime 的两种调用面**，而非两个独立 runtime：

| 调用面 | 包装 | 相对优势 |
|--------|------|---------|
| CodexSdkRuntime | @openai/codex-sdk Thread API | 进程内调用、nativeOutputSchema、原生 resume |
| CodexCliRuntime | CLI 子进程 (codex exec) | sandboxControl (--sandbox)、成熟稳定 |

```typescript
// Codex capabilities 共同点
{
  eventStreaming: true,
  extendedThinking: false,
  toolSurface: false,
}

// SDK 调用面额外能力
{ nativeOutputSchema: true, sessionPersistence: true, sandboxControl: false }

// CLI 调用面额外能力
{ nativeOutputSchema: false, sessionPersistence: { conditional: "sandbox=full-auto" }, sandboxControl: true }
```

**Fallback 策略**：CodexSdkRuntime.isAvailable() 失败时回退 CodexCliRuntime。
两者在 runtimeFactory 中注册为 `"codex-sdk"` 和 `"codex-cli"`，
但配置中也可用 `"codex"` 作为别名（优先 SDK，不可用时自动降级 CLI）。

## 配置

```typescript
interface PhaseRouting {
  runtime: string;    // 规范值: "claude-sdk" | "codex-sdk" | "codex-cli"
  model: string;      // 全量 model ID
}

// 配置读取时 normalize：
//   "codex" → "codex-sdk"（优先 SDK，运行时 isAvailable() 失败再 fallback CLI）
//   "claude" → "claude-sdk"
// normalize 在 Config 构造阶段完成，后续代码只看规范值。
// validateConfig 对非规范值 log.info 提示已 normalize。

interface RoutingConfig {
  brain:    PhaseRouting;
  plan:     PhaseRouting;
  execute:  PhaseRouting;
  review:   PhaseRouting;
  reflect:  PhaseRouting;
  scan:     PhaseRouting;
}
```

互斥规则（策略默认值，非硬规则）：
- **默认**：review 的 runtime+model 组合应不同于 execute 的组合（防自我验证偏差）
- **允许回落**：单 provider 场景（如只有 Claude 可用）可配置为同 runtime 不同 model，
  或同 runtime 同 model（此时 log.warn 提示但不阻断）
- 校验逻辑在 validateConfig 中实现为 warn，不是 throw

## 实施步骤

### A-1: RuntimeAdapter 接口 + ClaudeSdkRuntime（纯新增）

1. `src/runtime/RuntimeAdapter.ts` — 接口 + 类型
2. `src/runtime/ClaudeSdkRuntime.ts` — 包装现有 ClaudeCodeSession
3. `src/runtime/runtimeFactory.ts` — 配置→实例
4. 单元测试

### A-2: CodexSdkRuntime + CodexCliRuntime（纯新增）

1. `npm install @openai/codex-sdk`
2. `src/runtime/CodexSdkRuntime.ts` — SDK 模式，model 通过 config 透传
3. `src/runtime/CodexCliRuntime.ts` — 从 CodexBridge 提取，补 --model 参数
4. SDK + CLI fallback 逻辑

### A-3: 阶段解耦（替换）

1. BrainPhase: `ClaudeCodeSession` → `RuntimeAdapter`
2. ChainScanner: 同上
3. WorkerAdapter: 合并为 UnifiedWorkerAdapter，内部只调 runtime.run()
4. ReviewAdapter: 合并为 UnifiedReviewAdapter
5. MainLoop: runtimeFactory.create(routing.xxx) 替代直接 new

### A-4: 配置 + 清理

1. RoutingConfig 新定义，删 resolveModelId()
2. COMPLEXITY_CONFIG 去 model 字段（由 routing 或大脑 resource_request 决定）
3. 删除 CodingAgent/CodexBridge 旧接口
4. 文档更新

---

# 线 B：Brain-driven 认知解放

## 当前问题（护栏侵入认知层）

| 限制 | 位置 | 问题 |
|------|------|------|
| 探索被窄化 | BrainPhase:195 | "identify 1-5 concrete improvement opportunities" |
| 上下文被预消化 | BrainPhase:463 | gatherBrainContext() 固定窗口裁剪，大脑无补充检索权 |
| 自我批判被限定 | BrainPhase:202 | 三选一镜头，限制元认知自由度 |
| 反思被压缩 | BrainPhase:911 | 单行 LESSON，丢失策略洞察 |
| 工人指令被模板重组 | PersonaLoader:165 | 大脑意图被拆碎重组，信息量降低 |
| 资源分配被静态表控制 | WorkerPhase:49 | COMPLEXITY_CONFIG 硬编码，大脑无细粒度控制 |
| 降级到八股文 | BrainPhase:631 | brainDecideDirective 强制 8 选 1，否定模型能力 |

## 目标形态

### 大脑输出契约

```typescript
// brainDecide 输出
interface BrainDecision {
  // 大脑自由发挥区
  directive: string;           // 给工人的完整指令（自然语言，任意长度）
  summary: string;             // 一句话摘要（≤120字，写入 task_description，见下方持久化说明）
  strategy_note: string;       // 为什么做这个（给未来的自己看）

  // 编排器需要的最小结构
  resource_request: {
    budget_usd: number;        // 申请预算（编排器 cap）
    timeout_s: number;         // 申请超时（编排器 cap）
    model?: string;            // 可选覆盖 routing.execute.model（见下方解析策略）
  };
  verification_plan: string;   // 怎么验证做对了

  // 可选：多任务排队
  extra_tasks?: Array<{
    directive: string;
    resource_request: { budget_usd: number; timeout_s: number };
  }>;
}
```

### 反思输出契约

```typescript
// brainReflect 输出
interface BrainReflection {
  reflection: string;           // 多段落深度分析（自由文本）
  strategy_update: string;      // 策略级洞察（未来决策用）
  retrieval_lesson: string;     // 短文本（用于检索和去重，≈当前 LESSON）
  orchestrator_feedback?: string; // 对编排器行为的建议（可选）
}
```

### 工人指令传递

```
当前: 大脑 → JSON → PersonaLoader.buildWorkerPrompt() 重组 → 工人
目标: 大脑 → directive → PersonaLoader 只补通用规则 → 工人
```

PersonaLoader 降级为"轻量包裹器"：
- 加项目通用规则（CLAUDE.md 引用、git 规范等）
- **不拆碎、不重组大脑的 directive**
- directive 作为主体，通用规则作为补充

### 资源分配：request + cap

```
大脑: resource_request: { budget_usd: 12, timeout_s: 1800 }
编排器: min(request.budget, config.budget.maxPerTask) → 实际 budget
         min(request.timeout, HARD_TIMEOUT_CAP) → 实际 timeout
```

COMPLEXITY_CONFIG 从"决策器"降级为"默认建议值 + 硬上限"：
- 大脑不提 resource_request 时用默认值
- 大脑提了则用大脑的值，编排器只 cap

### resource_request.model 解析策略

大脑可在 resource_request 中请求特定 model 覆盖 routing.execute.model。
编排器按以下决策链处理：

```
1. model 为空 → 使用 routing.execute.model（正常路径）
2. model 与当前 execute runtime 兼容 → 采纳，log.info
   兼容判定：runtime.supportsModel(modelId): boolean
   - 由每个 runtime 实现自行判定（而非前缀表，避免模型命名变化导致漏判）
   - 判定来源：本地逻辑优先，远端 listing 仅作启动时 / 定时刷新缓存
     - 启动时：可选调用 provider API 拉取模型列表，缓存到内存
     - 运行时：只查本地缓存，不做网络调用（避免 provider 抖动影响路由）
     - 缓存 TTL：可配置，默认 24h；缓存未命中时按本地逻辑降级判定
   - 判定失败（未知 model）视为不兼容，不抛异常
3. model 与当前 execute runtime 不兼容 → 三种处理：
   a. 存在其他已注册 runtime 兼容该 model → 临时切换 runtime，log.warn
      例：execute runtime=claude-sdk，大脑请求 gpt-5.3-codex → 临时用 codex-sdk
   b. 无兼容 runtime 可用 → 忽略请求，使用 routing.execute.model，log.warn
      附带原因："model gpt-xxx requested but no compatible runtime available"
   c. 配置 experimental.strictModelRouting=true → 报错阻断（用于调试）
```

默认行为是 3b（忽略+warn），保证系统不因大脑的错误请求而中断。

## 实施步骤

### B-1: Brain-driven V1（提示词改造 + 数据迁移）

**数据迁移步骤（directive 新增列）：**

1. **表结构变更**（PG migration）：
   ```sql
   ALTER TABLE tasks ADD COLUMN directive TEXT;
   ALTER TABLE tasks ADD COLUMN strategy_note TEXT;
   ALTER TABLE tasks ADD COLUMN verification_plan TEXT;
   ALTER TABLE tasks ADD COLUMN resource_request JSONB;
   -- task_description 保留，不删不改（旧数据 + 旧路径仍使用）
   ```

2. **回填策略**：
   - 旧数据不回填 directive（旧任务本来就没有）
   - 新任务在 brainDriven=true 时写 directive + strategy_note；brainDriven=false 时只写 task_description（现有逻辑）
   - **summary 持久化规则**：summary 不单独建列，task_description 就是它的 canonical persisted form。
     - 新路径：`task_description = brain.summary`
     - 理由：task_description 已被 DB 索引、日志、UI 列表、去重逻辑、API 全面引用，
       再加一列 summary 会导致两个字段语义重叠且需要同步维护
     - 若大脑漏填 summary → 编排器 fallback：从 directive 前 120 字截取 + log.warn

3. **Web UI 显示**：
   - 任务详情页：directive 不为空时优先显示 directive（Markdown 渲染），否则显示 task_description
   - 任务列表：始终显示 task_description（截断摘要）
   - 新增 strategy_note 展示区（折叠面板）

4. **API / 导出接口兼容**：
   - GET /api/tasks 响应保留 task_description 字段（始终有值）
   - 新增 directive / strategy_note / resource_request 可选字段
   - SSE 事件流兼容：新字段追加不影响旧客户端解析

5. **task_logs 表 — brainReflect 日志**：
   - output_summary 只存 retrieval_lesson 短文本（与旧 LESSON 同角色，检索/去重友好）
   - reflection / strategy_update / orchestrator_feedback 存入 task_logs 新增 JSONB 列 `details`：
     ```sql
     ALTER TABLE task_logs ADD COLUMN details JSONB;
     ```
   - 写入时：
     ```typescript
     await this.taskStore.addLog({
       output_summary: reflection.retrieval_lesson,  // 短文本，列表/检索直接可用
       details: {
         reflection: reflection.reflection,
         strategy_update: reflection.strategy_update,
         orchestrator_feedback: reflection.orchestrator_feedback,
       },
     });
     ```
   - UI 展示：日志列表默认显示 output_summary（retrieval_lesson），
     details 按需展开（折叠面板，Markdown 渲染）
   - 旧日志 details 为 null，UI 判空后只显示 output_summary（向后兼容）

**删除的限制：**
1. 删 "identify 1-5 concrete improvement opportunities" 窄化
2. 删 "Pick ONE of these lenses" 单镜头自我批判
3. 删 brainDecideDirective 八股 fallback（整个方法可删）
4. 删 单行 LESSON 格式限制

**新增的提示词（极简化）：**
```
你是这个项目的技术负责人。

## 项目状态
[最小上下文：近期任务列表、预算、健康指标]

## 你的职责
- 决定下一步做什么（可以是一个任务或多个）
- 为工人写完整的执行指令（directive）
- 申请合理的资源（预算、超时）
- 说明怎么验证任务做对了

自由探索代码库，用你自己的判断力。不要自我设限。
```

**brainDecide outputSchema 更新：**
- `tasks[].task` → `directive`（自由文本，不限长度）
- 新增 `summary`（≤120字摘要，用于队列/日志/去重/UI，required）
- 新增 `resource_request`、`verification_plan`、`strategy_note`
- `persona`、`taskType`、`complexity` 标记为 deprecated + optional（不删）
  - 大脑可选填，不填时编排器从 directive 内容自动派生
  - DB schema / task log / Web UI 保留这些字段的显示
  - 后续 Phase 4 再评估是否完全移除，避免 DB/日志/UI/测试同时震荡

**brainReflect 输出更新：**
- 保留 retrieval_lesson（短文本，用于检索去重）
- 新增 reflection（长文本）、strategy_update、orchestrator_feedback
- 全部通过 outputSchema 提取

**工人指令直通：**
- WorkerPhase.workerExecute() 优先使用 directive 作为 prompt
- PersonaLoader.buildWorkerPrompt() 降为补充通用规则
- 不再把 workInstructions 拆成 filesToModify/guardrails 等碎片

### B-2: Context-on-demand（上下文拉取）

1. gatherBrainContext() 精简为最小初始状态（任务列表 + 预算 + 健康指标）
2. 大脑已有工具权限（Read/Glob/Grep/Bash），可自行拉取更多上下文
3. 去掉 CLAUDE_MEM_CONTEXT_MAX_CHARS 硬截断
4. claude-mem 搜索由大脑自主触发，不再由编排器预注入

### B-3: 资源申请制

1. brainDecide 输出包含 resource_request
2. COMPLEXITY_CONFIG 改为默认值表（大脑不提时用）+ 硬上限表
3. 编排器 apply: `min(brain_request, hard_cap)`
4. 大脑的 strategy_note 写入 task log，用于审计和学习

---

# 总体落地顺序

> 2026-03-08 最终收尾：Phase 1–4 全部完成。

```
Phase 1: A-1 + 薄接缝 + B-1(feature flag)                          ✅ 完成
  ├── A-1: RuntimeAdapter 接口 + ClaudeSdkRuntime (纯新增)
  ├── 薄接缝: BrainPhase/WorkerPhase 加 RuntimeAdapter 类型别名
  └── B-1: 大脑提示词改造 + directive 直通 + 反思扩展

Phase 2: A-2 + B-2  (可并行)                                        ✅ 完成
  ├── A-2: CodexSdkRuntime + CodexCliRuntime (纯新增)
  └── B-2: Context-on-demand (gatherBrainContext 精简)

Phase 3: A-3 + B-3  (有依赖，A-3 先)                                ✅ 完成
  ├── A-3: 所有主要阶段已改走 RuntimeAdapter；MainLoop 保留手动 register/resolve 接线（可接受）
  ├── B-3: resource_request 的 request + cap 已落地
  └── B-3: strategy_note 已写入 task_logs 审计日志（brainDecide addLog with details）

Phase 4: A-4 + flag 清理                                            ✅ 完成
  ├── 配置格式: model alias 集中在 Config 构造时 normalize
  ├── COMPLEXITY_CONFIG: 删除 model 字段，routing 为模型唯一来源
  ├── BrainPhase: 删除旧路径代码，brain-driven 成为唯一路径
  ├── ReviewTypes: 从 CodingAgent.ts 提取到独立 ReviewTypes.ts
  ├── feature flag: brainDriven 标记 @deprecated，行为始终启用（旧路径已删除，无回滚）
  ├── 评估结果: persona/taskType 从大脑 schema 移除；
  │   complexity 保留（用于 COMPLEXITY_CONFIG 资源默认值）；
  │   BrainOpts 保留 persona/taskType 字段以兼容队列中旧任务
  ├── 文档: README.md / README.zh-CN.md / docs/architecture.md 已同步到 RuntimeAdapter + routing 架构
  ├── CLAUDE_MEM_MODEL: 已评估，保留当前行为（opts.model 动态传入，硬编码仅为无 model 时的 fallback）
  ├── verification_plan: 已注入 worker prompt（workerExecuteBrainDriven），从存而不消变为存+消费
  └── CodexBridge 保留作为 CodexCliRuntime 的底层封装（设计上合理，不删）
```

### Feature Flag 设计（历史方案，当前已过时）

```typescript
// config.experimental (新增)
interface ExperimentalConfig {
  brainDriven: boolean;           // 默认 false — 启用 B-1/B-2 新路径
  strictModelRouting: boolean;    // 默认 false — true 时 model/runtime 不兼容直接报错阻断（调试用）
}
```

- 当前实现中，`brainDriven` 仅为 **配置兼容字段**；旧路径已删除，运行时始终走 brain-driven 新路径。
- `strictModelRouting` 仍有效，继续用于 `resource_request.model` 与 runtime 不兼容时的严格阻断。
- 因此下面的 rollout / A/B 放量设计保留为历史记录，不再代表当前代码的可回滚能力。

## Rollout / Eval：brainDriven flag 放量标准（历史记录）

### 评估指标

brainDriven=true 与 brainDriven=false 对比以下指标，数据来源为 tasks 表 + task_logs 表：

| 指标 | 计算方式 | 放量门槛（B = baseline 值） |
|------|---------|---------------------------|
| **任务完成率** | completed / total | new >= B - 0.05 |
| **硬验证通过率** | 首次 hardVerify passed / total_executions | new >= B - 0.03 |
| **review 通过率** | 首次 codeReview passed / total_reviews | new >= B |
| **回滚率** | (blocked + failed) / total | new <= B + 0.05 |
| **平均任务成本** | SUM(cost_usd) / completed | new <= B * 1.3 |
| **平均任务时长** | AVG(duration_ms) for completed | new <= B * 1.5 |
| **大脑决策成本** | brain phase cost_usd / total | new <= B * 2.0 |

### 分阶段放量

```
Stage 0: brainDriven=false (默认)
  → 运行 A-1 完成后的系统，收集 baseline 指标（≥ 20 任务）

Stage 1: brainDriven=true, 人工观察
  → 开启 flag，跑 20 任务，人工 review directive 质量和 strategy_note 合理性
  → 关注：directive 是否比旧 task_description 信息量更大、工人是否更好地执行了意图

Stage 2: 指标对比
  → 与 Stage 0 baseline 对比上述 7 个指标
  → 全部达标 → 进入 Stage 3
  → 任何指标严重恶化（>10pp） → 回退到 flag=false，分析原因

Stage 3: 默认开启
  → flag 默认改为 true，旧路径保留但标记 deprecated
  → Phase 4 时移除旧路径和 flag
```

### 关停条件

任何时候出现以下情况，立即回退 flag=false：
- 连续 3 个任务 blocked（大脑决策失控）
- 单任务成本 > maxPerTask × 2（resource_request cap 失效）
- directive 解析失败率 > 30%（outputSchema 契约不稳定）

### 日志支持（当前状态）

- 已落地：`reflect` 阶段会把 `reflection / strategy_update / orchestrator_feedback` 写入 `task_logs.details`
- 已落地：`directive / strategy_note / verification_plan / resource_request` 会写入 `tasks` 表对应列
- 未完全落地：这里原设计的 `brain-decide` 新旧路径 A/B 对比日志，在当前“单一路径”实现中已不再适用
- 未完全落地：`strategy_note` 目前持久化到了 `tasks.strategy_note`，但尚未额外写入 `task_logs` 审计日志

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Codex SDK 不稳定 | SDK + CLI 双通道，isAvailable() fallback |
| 大脑 structured output 依赖 | 所有 runtime 有文本 fallback 解析（已存在） |
| SdkExtras 仅 Claude 可用 | ClaudeSdkRuntime 独占；其他 runtime 忽略 |
| 大脑放飞后质量不稳定 | retrieval_lesson 短文本保留检索去重；resource_request 有 cap |
| directive 过长超 token 限制 | 编排器截断 + warn，不静默丢弃 |
| 迁移期间功能回归 | Phase 1-2 纯新增不改旧代码；Phase 3 有测试保护 |
| 大脑申请过高预算 | config.budget.maxPerTask 硬 cap，日预算硬 cap |
| DB/日志字段变更 | persona/taskType/complexity 标 deprecated 不删；directive 新增列；旧数据保留 |
| B-1 绑死旧抽象再返工 | Phase 1 先建薄接缝，B-1 在 feature flag 后面面向新接口编写 |

## 成功标准

### 线 A
- [x] `routing.brain.runtime = "codex-sdk"` 时大脑能正常决策
      代码路径验证: ✅ (6 个 mock 测试: outputSchema、readOnly、disallowedTools/toolSurface、systemPrompt、resume、error)
      真实运行验证: ✅ (4 个真实 API 测试全通过: isAvailable、simple prompt、outputSchema BrainDecision、runBrainThink e2e)
      关键修复: CodexSdkRuntime.strictifySchema() 自动规范化 schema 为 OpenAI strict 模式 (additionalProperties:false + 全量 required)
      已知限制: disallowedTools 被静默忽略 (toolSurface=false)，MCP 变更工具不受控但 Codex 环境无此类工具
- [x] `routing.execute.model = "gpt-5.3-codex"` 时工人可通过 runtime routing 执行任务
- [x] model ID 全量透传，无旧式别名降级
- [x] 新增 runtime 只需实现 `RuntimeAdapter` + 注册到 factory / registry

### 线 B
- [x] 大脑输出 `directive` 直通工人，不经 PersonaLoader 重组
- [x] 反思输出 `reflection + retrieval_lesson + strategy_update`
- [x] 资源由大脑 request + 编排器 cap，不走旧的模型硬编码复杂度路由
- [x] `gatherBrainContext` 只提供最小状态，大脑自主补充检索
- [x] 删除 `brainDecideDirective` 八股 fallback
- [x] 删除单镜头自我批判限制

### 整体
- [x] 现有测试全部通过（2026-03-08 收尾后通过，686 tests）
- [x] 编排器已明显收缩认知微操，只保留 framing / 安全边界 / 输出契约为主
- [x] feature flag 回滚能力：不再适用（旧路径已删除，brain-driven 为唯一路径）
- [x] `persona/taskType/complexity` 在 B-1 中保留兼容策略，DB/UI 未被破坏
- [x] 架构文档与实现同步（README.md / README.zh-CN.md / docs/architecture.md 已更新）
- [x] `strategy_note` 写入 task_logs 审计链路（brainDecide addLog with details JSONB）
- [x] `verification_plan` 注入 worker prompt 消费（不再只存不消费）
- [x] 前端 task_logs details 展开显示（renderLogDetails 折叠面板）

## 测试矩阵

### 1. RuntimeAdapter 契约测试（A-1/A-2）

每个 runtime 实现必须通过同一组契约测试（参数化测试，runtime 作为变量）：

| 测试 | 验证内容 |
|------|---------|
| run-basic | 给 prompt 返回 RunResult，字段类型正确 |
| run-readOnly-hard | sandboxControl=true 的 runtime：readOnly=true 时原生沙箱阻止文件变更 |
| run-readOnly-soft | sandboxControl=false 的 runtime：readOnly=true 时通过 prompt/disallowedTools 约束（测试验证约束被传递，不断言零文件变更） |
| run-outputSchema | 支持时返回 structured；不支持时 structured=undefined + text fallback |
| run-resume | sessionPersistence=true 时传 resumeSessionId 能恢复；conditional 时按条件降级 |
| run-timeout | timeout 到期后返回 isError=true |
| run-model | model 透传到底层调用（mock 验证） |
| supportsModel | 已知模型返回 true，未知模型返回 false，不抛异常 |
| isAvailable | runtime 可用返回 true，不可用返回 false，不抛异常 |
| capabilities-static | capabilities 字段值与文档声明一致 |

### 2. Routing / Config 测试（A-3/A-4）

| 测试 | 验证内容 |
|------|---------|
| normalize-alias | `"codex"` → `"codex-sdk"`，`"claude"` → `"claude-sdk"` |
| normalize-passthrough | `"codex-cli"` 不被改写 |
| validate-mutual-exclusion | review=execute 同 runtime+model → log.warn（不 throw） |
| validate-unknown-runtime | 未注册 runtime 名 → throw |
| model-routing-compatible | resource_request.model 兼容 → 采纳 |
| model-routing-cross-runtime | resource_request.model 不兼容但有其他 runtime → 临时切换 |
| model-routing-fallback | resource_request.model 无兼容 runtime → 忽略 + warn |
| model-routing-strict | strictModelRouting=true + 不兼容 → throw |

### 3. Migration roundtrip 测试（B-1）

| 测试 | 验证内容 |
|------|---------|
| migration-up | ALTER TABLE 执行后新列存在且 nullable |
| migration-old-data | 旧任务 directive=null，task_description 不变 |
| migration-new-task | brainDriven=true 时 directive/strategy_note/resource_request 写入正确 |
| migration-summary-to-desc | summary 写入 task_description，不建 summary 列 |
| migration-summary-fallback | summary 为空时从 directive 截取 + warn |
| task-logs-details | brainReflect 日志 details JSONB 写入/读取 roundtrip |
| task-logs-legacy | 旧日志 details=null，UI 只显示 output_summary |

### 4. Feature flag A/B 测试（B-1）

| 测试 | 验证内容 |
|------|---------|
| flag-false-legacy | brainDriven=false → 走旧 explorationPrompt + 旧 schema |
| flag-true-new | brainDriven=true → 走极简 prompt + BrainDecision schema |
| flag-toggle | 重启后 flag 生效（Config 启动时构造一次，无热重载） |
| flag-directive-passthrough | brainDriven=true 时 directive 直通 worker，不经 PersonaLoader 重组 |
| flag-reflect-expanded | brainDriven=true 时反思输出 reflection + retrieval_lesson + strategy_update |

### 5. Legacy/new 回归测试（Phase 3/4）

| 测试 | 验证内容 |
|------|---------|
| e2e-legacy-cycle | brainDriven=false 全流程 cycle 通过（brainDecide→execute→verify→review→reflect） |
| e2e-new-cycle | brainDriven=true 全流程 cycle 通过 |
| api-backward-compat | GET /api/tasks 旧客户端能正常解析（task_description 始终有值） |
| ui-directive-display | directive 非空时详情页显示 directive，否则显示 task_description |
| codex-fallback | codex-sdk 不可用时自动降级到 codex-cli |
