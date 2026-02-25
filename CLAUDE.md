# db-coder

自主 AI 编码 agent。编排器 (Node.js) 驱动大脑和工人两个 Claude Code session 协作。

## 架构

```
编排器 (MainLoop, ~2400行)
  ├── 大脑 session (Agent SDK query(), 只读+记忆, 决策+反思)
  ├── 工人 session (Agent SDK query(), 读写, 编码执行)
  ├── 程序化 Hooks (PreToolUse/PostToolUse 观察)
  ├── 插件自动发现 (~/.claude/plugins/cache)
  ├── 硬验证 (tsc 错误计数对比)
  ├── Codex 审查 (codex exec, diff 级审查, 置信度过滤)
  └── Web UI + API (SPA :18800)
```

核心循环: `brainDecide() → workerExecute() → hardVerify() → specReview() → codexReview() → brainReflect() → mergeBranch() → [deepChainReview] → [claudeMdMaintenance]`

## 当前状态

- [x] 核心循环 (MainLoop v2, brain+worker 模式)
- [x] ClaudeCodeSession (Agent SDK query() 封装, ~226行)
- [x] Agent SDK (v0.2.52 query API + hooks + plugins + 复杂度分级 S/M/L/XL)
- [x] 巡逻模式 (自动循环, PatrolManager 管理启停)
- [x] Web UI (SPA, 巡逻控制 + 任务列表)
- [x] 费用追踪 (daily_costs 表 + CostTracker)
- [x] Git 分支管理 (自动创建/合并/清理/孤儿分支清理)
- [x] 硬验证 (tsc 错误计数对比基线)
- [x] 三阶段审查 (hardVerify → specReview(Brain) → codexReview(Codex))
- [x] 自修改重启 (safeBuild + exit code 75)
- [x] 计划对话 (PlanChatManager + ClaudeCodeSession)
- [x] 始终进化模式 (大脑反思驱动, CLAUDE.md + claude-mem)
- [x] CLAUDE.md 自动维护 (brainReflect + 周期性 claudeMdMaintenance 每 15 任务)
- [x] 深度链路审查 (每 5 个任务触发, 可编辑 CLAUDE.md)
- [x] CycleEventBus (guards + observers 事件驱动架构)
- [x] Persona 专业化 (PersonaLoader + personas 表 + 统计)

## 环境

- PostgreSQL: `docker exec dev-postgres psql -U db -d db_coder`
- 构建: `npm run build` (npx tsc + copy web)
- 测试: `npm test`
- 服务: `node dist/index.js serve --project .`
- Node.js >= 22, TypeScript 5.7+

## DB Schema (活跃表)

```sql
tasks: id(uuid), project_path, task_description, phase, priority(0-3),
       plan(jsonb), subtasks(jsonb), review_results(jsonb), iteration,
       total_cost_usd, git_branch, start_commit, depends_on(uuid[]),
       evaluation_score(jsonb), evaluation_reasoning, status,
       created_at, updated_at

task_logs: id(serial), task_id(fk), phase, agent, input_summary,
           output_summary, cost_usd, duration_ms, created_at

daily_costs: date(pk), total_cost_usd, task_count

plan_drafts: id(serial), project_path, plan(jsonb), status,
             chat_session_id, chat_status, created_at

plan_chat_messages: id(serial), session_id, role, content,
                    metadata(jsonb), created_at

service_state: (project_path, key)(pk), value, updated_at

personas: id(serial), name(unique), role, content, task_types(text[]),
          focus_areas(text[]), usage_count, success_rate, created_at
```

停用表 (不删除, 停止写入): adjustments, scan_modules, scan_results,
evaluation_events, review_events, goal_progress, prompt_versions, config_proposals

## 功能链路 (深度审查用)

### 自主循环
入口: `MainLoop.runCycle()`
路径: [queue-pickup | brainDecide → createTask] → workerExecute(分支) → hardVerify → [workerFix 重试] → specReview(Brain) → codexReview(Codex) → brainReflect → [merge | cleanup] → [deepChainReview 每5任务] → [claudeMdMaintenance 每15任务]
关注: 错误向上冒泡, 验证失败阻止合并, 费用追踪完整
已知缺陷: merge 失败丢弃有效工作 (无 rebase 重试); brainReflect 在 merge 前运行 (失败丢弃已验证代码); 成功路径 switch/merge/delete 无独立异常隔离; catch/finally 中 switchBranch 在 dirty state 下静默失败

### 任务执行
入口: `workerExecute(task)`
路径: ClaudeCodeSession.run(prompt) → Agent SDK query() → 编码 → git commit → 返回 SessionResult
关注: timeout 处理, 成本追踪, sessionId 用于 workerFix 续传, complexity 分级控制资源 (S/M/L/XL)
已知缺陷: workerExecute 返回后不检查 isError; workerFix 的 sessionId="" 导致重试循环提前退出

### 硬验证
入口: `hardVerify(baselineErrors, startCommit, projectPath)`
路径: countTscErrors (对比基线) → getDiffStats (检查是否有实际变更)
关注: 基线错误数必须可靠, tsc 失败返回 -1 时不阻止合并
已知缺陷: getDiffStats 结果仅用于 warn, 未用于 pass/fail (空 diff 检查未实现); baselineErrors 在 runCycle call site 不验证 <0, 崩溃 baseline 导致验证自动 pass

### 规格审查
入口: `specReview(task, startCommit, projectPath, workInstructions?)`
路径: getDiffSince(startCommit) → 构建 prompt (含 diff + task + subtasks + acceptanceCriteria) → brainThink → JSON.parse → 返回 {passed, missing, extra, concerns}
关注: diff 截断 (15000 字符) 无标记, JSON 解析失败重试一次后 FAIL, startCommit="" 时 diff 不可用但仍执行
已知缺陷: parseSpecResult 用 JSON.parse 而非 extractJsonFromText; diff.slice(0,15000) 无截断标记; startCommit="" 时浪费全部审查费用

### 反思
入口: `brainReflect(task, outcome, verification, projectPath, personaName?)`
路径: brainSession.run(反思 prompt, allowedTools=[Edit,Write...]) → 解析 PERSONA_UPDATE 块 → 更新 persona 统计
关注: 运行在任务分支上, 可编辑 CLAUDE.md 和 persona, 失败会导致整个任务 failed
已知缺陷: 在任务分支上执行导致 reject 时丢失编辑; 成功时未提交编辑泄漏到 main; 在 merge 前运行, 失败阻止已验证任务合并

### 审查合并 (已删除)
`mergeReviews()`, `extractIssueCategories()`, `higherSeverity()` 已删除 — 死代码, 从未在 runCycle 中调用, 且有多个已知 bug。
`countTscErrors()` 保留 (被 hardVerify 使用)。当前流水线用 specReview (Brain) + codexReview (Codex) 独立审查。

## 设计原则

1. **失败必须可见** — 关键路径不允许 catch-ignore, 错误向上冒泡
2. **单一记忆源** — CLAUDE.md (规则/状态) + claude-mem (经验), 不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板, 让 session 用自己的工具链
4. **硬验证优先** — tsc + test 是唯一真实质量信号
5. **极简编排** — 编排器只做控制流, 不做 AI 推理
6. **端到端闭环** — 每条链路必须可测试验证
7. **始终进化** — 大脑每 cycle 必须产出任务，"nothing to do" 不可接受

## 踩过的坑

- 嵌套运行 Claude: 必须清除 CLAUDECODE 等环境变量, 否则子进程拒绝启动
- postgres JSONB: 用 `sql.json()` 不要 `JSON.stringify()` + `::jsonb`
- 验证失败绝不默认 pass: 验证逻辑必须在异常时阻止合并
- 数值化进化评分不工作: 改用自然语言规则 (CLAUDE.md + claude-mem)
- Agent SDK permissionMode: 非交互场景必须用 `bypassPermissions`
- 1431 行 prompt 模板限制 Claude 能力: 删除所有模板, 让 Claude 自主推理
- patrol lock 自死锁: acquireLock/releaseLock 必须在 start() 的 finally 中
- 前端 innerHTML: marked.parse() 后必须过 DOMPurify.sanitize() 再赋值
- 空 git diff 应自动失败: 任务期望代码变更但 diff 为空时不能标成功
- `void asyncFn()` 反模式: 同步回调中用 `asyncFn().catch(handleError)` 替代
- 类型不要重复定义: import 已有类型而不是在本地重新派生, 类型漂移是静默 bug
- 清理函数改动时: 检查所有 class 级 Map/Set 是否都有对应的 .delete() 清理
- Brain "nothing to do" 死循环: prompt 不能给 null 出口, 必须提供进化维度和模块聚焦
- SDK isolation mode 默认不加载任何设置: 必须设置 settingSources: ['user', 'project', 'local']
- SDK bypassPermissions 必须同时设置 allowDangerouslySkipPermissions: true
- SDK systemPrompt preset 'claude_code' 获得完整工具链: 不要自定义系统 prompt
- SDK kill() vs timeout: exitCode -2 = manual kill, -1 = timeout, 用 killed 布尔标志区分
- 流式行解析 buffer flush: split('\n') + buffer 模式最后一行可能没有 trailing newline, close handler 必须 flush 剩余 buffer
- SDK is_error 与 errors 字段独立: subtype=success 但 is_error=true 时 errors 可能为空, 需要合成诊断信息
- Codex 输出是 Markdown 不是 JSON: tryParseReview 必须有 Markdown 回退解析, 否则丢失审查发现
- Codex token 定价要跟踪模型实际价格: output 价格差异最大 (曾经低估 43%), 导致费用追踪不准
- Worker 格式污染是头号任务杀手: 引号 '→" 和对象重排版导致 diff 膨胀。persona 文字警告无效 (10+ 条规则仍被忽略), 需 hardVerify diff 信号比检测 (逻辑变更行/总行 < 30% 应 fail)。bugfix-debugger persona 20% 成功率的主因
- 格式污染二阶效应: diff 膨胀超 specReview 15000 字符截断后, Brain 看不到核心变更误判 "未实现"。git diff -w 对引号替换无效。治标: truncateDiffSmart() [待合并]; 治本: diff 信号比检测
- 流水线中断后任务状态残留: specReview 后若 codexReview 阶段异常或服务重启, 任务永远停在 active/executing, 不会被自动恢复或标记失败。需要 cycle 级 try/catch 保证任务最终状态一致
- CLI 命令错误处理不一致: 8/9 旧命令无 try/catch (错误自然冒泡), 新增命令全部 try/catch 并吞掉错误。应统一: 要么全部加 try/catch, 要么让 commander 的全局 error handler 处理
- hardVerify 空 diff 检查未实现: CLAUDE.md 记录了"空 git diff 应自动失败"但 hardVerify 只 warn >15 files, 不检查 files_changed===0。getDiffStats 结果未用于 pass/fail 判定 [已修复 9258ac2, 因格式污染致 specReview 误杀, 未合并]
- Merge 冲突丢弃有效工作: mergeBranch 抛异常时被外层 catch 标 failed + cleanupTaskBranch 删除分支, 成功编码的工作永久丢失。应先尝试 rebase 重试, 失败再人工介入
- Worker 超时后 dirty git state: session 超时/崩溃时工作目录可能有未提交文件, catch/finally 中 switchBranch .catch(()=>{}) 静默失败, 后续循环在错误分支上运行。需要在 switchBranch 前 git reset --hard
- workerExecute 不检查 isError: session 返回 isError=true 的结果直接传给 hardVerify, 浪费验证+审查资源。应在 workerExecute 返回后检查 isError 并提前 fail [已修复 6fd4106, 待合并]
- Fix 重试循环因 sessionId="" 提前退出: makeErrorResult 返回 sessionId="" (空字符串), ?? 操作符不区分 "" 和 null, currentSessionId 变为 "" (falsy), while 循环条件 `currentSessionId &&` 立即退出, 浪费剩余重试预算 [已修复 6fd4106, 待合并]
- commitAll .catch(()=>{}) 导致验证在旧代码上运行: fix 阶段的 commit 失败被静默忽略, 后续 hardVerify 验证的是 commit 前的旧状态, 产生误导性结果 [已修复 6fd4106, 待合并]
- MainLoop 无测试 harness: ~2400 行核心编排逻辑完全没有测试基础设施, 每次 bugfix 都因 specReview 要求集成测试而失败。需要先建立最小 mock 层 (ClaudeCodeSession/TaskStore/CostTracker 的 stub), 才能对 MainLoop 进行可测试的 bugfix
- CycleEventBus emit() vs emitAndWait(): emit() 是 fire-and-forget, guard 必须用 emitAndWait() + 检查 Error[]。EmptyDiffGuard [已修复 85bf68f, 待合并], before:decide [已修复 ff2c8d7, 待合并]
- ConcurrencyGuard 仅覆盖 brainDecide 路径: guard 在 runCycle else 分支内 (line 465), queue-pickup 路径 (lines 413-462) 完全绕过 guard, 两个实例同时拾取 queued 任务不会被阻止。若要保护完整 cycle, guard 应放在 line 413 之前
- startCommit 空字符串回退误导 diff 计算: getHeadCommit 失败返回 "", 传给 getDiffStats/specReview 时 git diff "" HEAD 行为不可预测。应 fail-fast 而非静默降级 [已修复 d3dd899, 因测试文件格式污染导致 specReview 误杀, 未合并]
- mergeReviews 去重逻辑反转 [已删除: 死代码已移除]
- baselineErrors=-1 时 hardVerify 直接 pass: countTscErrors 在 runCycle 开头获取 baseline 但不检查 <0, 传给 hardVerify 后 `baselineErrors >= 0 && currentErrors > baselineErrors` 短路跳过比较, 最终返回 passed:true。tsc 崩溃不应导致验证自动通过 [已修复 9258ac2, 因格式污染致 specReview 误杀, 未合并]
- specReview diff 截断无标记: diff.slice(0, 15000) 后 brain 看到截断的 diff 但不知道被截断, 可能在部分信息上做出"全部实现"的错误判断。应追加 "[... truncated]" 标记 [已修复 90bd756, 因 Codex 误杀预存问题未合并]
- specReview diff 排序导致核心变更被截断: git diff 按字母序排文件, .test.ts 常排在 .ts 前面, 测试文件的格式噪音占满 15000 字符后核心源码变更完全不可见。应按 .ts → .test.ts 排序, 或为每个文件分配配额
- CostTracker.sessionCost 纯内存态: 进程崩溃后 sessionCost 归零, 与 DB daily_costs 不一致。getSessionCost() 报告的值仅反映当前进程生命周期, 不可用于跨重启的预算连续性判断
- mergeReviews Jaccard 阈值 0.4 偏低 [已删除: 死代码已移除]
- makeErrorResult 返回 sessionId="" 而非 null: 语义不清 — 调用方无法区分"无 session (不可恢复)" 和 "有 session 但出错 (可恢复)"。应返回 null 表示不可恢复, 非空字符串表示可恢复
- Codex 审查对小修复系统性误杀: 只传 changedFiles 不传 diff, 2 行修复在大文件中被找出无关预存问题标 FAIL。应传 diff 上下文, 小 diff 降低问题数量要求
- Codex 审查对有意删除也误杀: prompt 缺少 task description, 无法区分"意外删除"和"有意清理"
- 删除模块时必须 grep 文档目录确认无残留引用
- mergeReviews 是死代码 [已删除: 死代码已移除]
- getCurrentBranch .catch(() => "main") 静默回退: 失败时 originalBranch 默认 "main" 可能错误, 应 fail-fast
- Queue-pickup 路径在分支创建前标记 "active": 崩溃窗口导致任务无 git_branch 但 status=active
- after:execute subtask 路径硬编码零成本: guard/observer 看不到真实资源消耗
- countTscErrors 超时不返回 -1: tsc 超时返回 0 (非 -1), 被误解为编译成功 [已修复 a19ca93, 但因测试文件格式污染导致 specReview 误杀, 未合并]
- brainReflect 在任务分支上执行: 反思阶段可 Edit CLAUDE.md, 但运行在任务分支上。任务被 reject 时 cleanupTaskBranch 删除分支, 反思学到的 CLAUDE.md 修改随分支永久丢失。应在 merge/reject 判断之后、对应分支上执行, 或反思产出独立提交到 main
- mergeBranch 成功后 deleteBranch 失败标任务 failed: merge → delete → 异常被外层 catch 标 failed, 但代码已合并到 main。应对 deleteBranch 单独 catch, 合并成功即为成功
- specReview parseSpecResult 用 JSON.parse 而非 extractJsonFromText: brain 返回 "Here's the review:\n{...}" 时解析失败触发完整重试, 浪费 ~$0.5-2。应先尝试 extractJsonFromText 提取嵌入的 JSON
- subtask 路径 workerExecute 也不检查 isError: executeSubtasks 中 workerExecute 返回后仅检查 costUsd>0, 不检查 isError, 失败的 session 继续进入 per-subtask hardVerify
- deepChainReview/claudeMdMaintenance 费用绕过 CostTracker: 直接调用 taskStore.addDailyCost() 不经过 CostTracker.addCost(), sessionCost 累计偏低, getSessionCost() 不反映全部开销。影响: 仅日志/监控不准, 不影响 DB 预算检查
- brainReflect 失败导致已验证任务丢失: brainReflect 在外层 try/catch 内 (line 960)。session 超时/崩溃时 catch 标 failed + 删除分支, 但任务已通过 hardVerify+specReview+codexReview。反思是非关键学习步骤, 不应阻止合并。应把 brainReflect 包在独立 try/catch 或移到 merge 之后
- brainReflect 未提交编辑泄漏到 main: 成功路径上, brainReflect 编辑 CLAUDE.md 但不保证 commit。switchBranch(originalBranch) 时 git 携带未提交变更到 main (因 CLAUDE.md 在两分支上相同)。后续 cycle 在 dirty 工作目录运行, 累积未提交变更。若 CLAUDE.md 在分支间有差异, switchBranch 直接报错进 catch, 已验证代码丢失
- 成功路径 merge 序列无独立异常隔离: switchBranch → mergeBranch → deleteBranch 三步共享外层 catch。switchBranch 失败 (如 brainReflect 导致 dirty state) → 代码未 merge 但被 cleanup 删除 → 已通过全部审查的代码永久丢失。应对三步各自 try/catch, 按实际成功程度设置状态
- specReview 在 startCommit="" 时浪费费用: getHeadCommit 失败 → startCommit="" → getDiffSince 失败 → specReview 收到 "(diff unavailable)" → Brain 仍执行完整审查 (~$0.5-2) 但基于无用数据。应在 startCommit 为空时跳过 specReview
- sessionCost 系统性低估: 除已知的 deepChainReview/claudeMdMaintenance 外, brainDecide/brainDecideDirective/triggerScan/triggerIdentifyModules/triggerModuleScan (共 7 个调用点) 也直接用 taskStore.addDailyCost(), 全部绕过 CostTracker.sessionCost。getSessionCost() 仅反映 worker+verify+review 阶段
- getNextTask 无原子拾取保护: SELECT ... LIMIT 1 没有 FOR UPDATE SKIP LOCKED。acquireLock 文件锁仅在单机上有效。文件锁失败或多机部署时, 两个实例可同时拾取同一个 queued 任务
