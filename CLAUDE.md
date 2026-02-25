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

核心循环: `brainDecide() → workerExecute() → hardVerify() → specReview() → codexReview() → brainReflect() → mergeBranch() → [chainScan] → [claudeMdMaintenance]`

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
- [x] 链路扫描 (ChainScanner, 自动推导入口+边界验证, 轮转+记忆)
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

chain_scan_state: project_path(pk), next_index, entry_points(jsonb),
                  known_fingerprints(jsonb), last_discovery_at,
                  last_scan_at, scan_count, updated_at
```

停用表 (不删除, 停止写入): adjustments, scan_modules, scan_results,
evaluation_events, review_events, goal_progress, prompt_versions, config_proposals

## 功能链路

### 自主循环
入口: `MainLoop.runCycle()`
路径: [queue-pickup | brainDecide → createTask] → workerExecute(分支) → hardVerify → [workerFix 重试] → specReview(Brain) → codexReview(Codex) → brainReflect → [merge | cleanup] → [chainScan 每N任务] → [claudeMdMaintenance 每15任务]
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

## 设计原则

1. **失败必须可见** — 关键路径不允许 catch-ignore, 错误向上冒泡
2. **单一记忆源** — CLAUDE.md (规则/状态) + claude-mem (经验), 不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板, 让 session 用自己的工具链
4. **硬验证优先** — tsc + test 是唯一真实质量信号
5. **极简编排** — 编排器只做控制流, 不做 AI 推理
6. **端到端闭环** — 每条链路必须可测试验证
7. **始终进化** — 大脑每 cycle 必须产出任务，"nothing to do" 不可接受
8. **目标项目无关性** — db-coder 最终要扫描/编码任意项目，所有功能实现不能依赖目标项目的特定结构 (如手写的 CLAUDE.md 链路定义)，必须从代码本身自动推导所需信息

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
- Worker 格式污染: 引号 '→" 和对象重排版导致 diff 膨胀, 是头号任务杀手 (bugfix-debugger 20% 成功率主因)。persona 文字警告无效, 需 diff 信号比检测 (逻辑行/总行 < 30% 应 fail)。二阶效应: 膨胀的 diff 超 specReview 15000 字符截断, Brain 误判"未实现"
- 流水线中断后任务状态残留: specReview 后若 codexReview 异常或服务重启, 任务永停 active/executing。需 cycle 级 try/catch 保证最终状态一致
- CLI 命令错误处理不一致: 旧命令无 try/catch (自然冒泡), 新增命令 try/catch 吞错误。应统一
- hardVerify 多重缺陷: (1) 空 diff 只 warn 不 fail [已修复 9258ac2, 未合并]; (2) baselineErrors=-1 时短路自动 pass [已修复 9258ac2, 未合并]; (3) countTscErrors 超时返回 0 误认编译成功 [已修复 a19ca93, 未合并]
- 成功路径异常隔离缺失: merge 冲突/dirty git state/deleteBranch 失败都走外层 catch, 已验证代码被 cleanup 永久丢失。switchBranch 前需 git reset --hard; 三步应各自 try/catch; deleteBranch 失败不应标 failed
- worker 执行/重试缺陷: (1) workerExecute 不检查 isError, 失败 session 继续 hardVerify [已修复 6fd4106, 未合并]; (2) makeErrorResult sessionId="" 导致 while 循环提前退出 [已修复 6fd4106, 未合并]; (3) commitAll .catch(()=>{}) 致验证在旧代码上运行 [已修复 6fd4106, 未合并]; (4) subtask 路径同样不检查 isError
- brainReflect 三重问题: (1) 在任务分支上运行, reject 时丢失学习; (2) 未 commit 编辑泄漏到 main 或在分支差异时报错丢代码; (3) 失败标 failed 阻止已验证任务合并, 应独立 try/catch 或移到 merge 之后
- specReview 多重缺陷: (1) diff 截断无标记 [已修复 90bd756, 未合并]; (2) diff 按字母序排, .test.ts 占满截断后核心变更不可见; (3) parseSpecResult 用 JSON.parse 而非 extractJsonFromText [重试浪费 ~$0.5-2]; (4) startCommit="" 时浪费全部审查费用
- CostTracker 系统性绕过: chainScan/claudeMdMaintenance/brainDecide 等 7+ 调用点直接用 taskStore.addDailyCost() 绕过 CostTracker.addCost(), sessionCost 仅反映 worker+verify+review。进程崩溃后 sessionCost 归零与 DB 不一致
- makeErrorResult 返回 sessionId="" 而非 null: 调用方无法区分"无 session"和"有 session 但出错"
- Codex 审查误杀: 小修复只传 changedFiles 不传 diff 被找出预存问题标 FAIL; prompt 缺 task description 无法区分有意删除
- 删除模块时必须 grep 文档目录确认无残留引用
- getCurrentBranch .catch(() => "main") 静默回退: 失败时默认 "main" 可能错误, 应 fail-fast
- Queue-pickup 路径在分支创建前标记 "active": 崩溃窗口导致任务无 git_branch 但 status=active
- after:execute subtask 路径硬编码零成本: guard/observer 看不到真实资源消耗
- CycleEventBus emit() vs emitAndWait(): emit() 是 fire-and-forget, guard 必须用 emitAndWait() + 检查 Error[] [已修复 85bf68f+ff2c8d7, 未合并]
- ConcurrencyGuard 仅覆盖 brainDecide 路径: queue-pickup 完全绕过 guard, 两实例可同时拾取同一任务
- startCommit 空字符串回退误导 diff 计算: getHeadCommit 失败返回 "" 传给 git diff 行为不可预测, 应 fail-fast [已修复 d3dd899, 未合并]
- MainLoop 无测试 harness: ~2400 行核心编排逻辑无测试基础设施, 需先建立 mock 层
- getNextTask 无原子拾取保护: SELECT 无 FOR UPDATE SKIP LOCKED, 文件锁仅单机有效
