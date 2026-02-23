# db-coder

自主 AI 编码 agent。编排器 (Node.js) 驱动大脑和工人两个 Claude Code session 协作。

## 架构

```
编排器 (MainLoop, ~530行)
  ├── 大脑 session (Claude Code CLI, 只读+记忆, 决策+反思)
  ├── 工人 session (Claude Code CLI, 读写, 编码执行)
  ├── 硬验证 (tsc 错误计数对比)
  ├── Codex 审查 (codex exec, diff 级审查)
  └── Web UI + API (SPA :18800)
```

核心循环: `brainDecide() → workerExecute() → hardVerify() → codexReview() → brainReflect() → mergeBranch()`

## 当前状态

- [x] 核心循环 (MainLoop v2, brain+worker 模式)
- [x] ClaudeCodeSession (Claude Code CLI stream-json 封装)
- [x] 巡逻模式 (自动循环, PatrolManager 管理启停)
- [x] Web UI (SPA, 巡逻控制 + 任务列表)
- [x] 费用追踪 (daily_costs 表 + CostTracker)
- [x] Git 分支管理 (自动创建/合并/清理/孤儿分支清理)
- [x] 硬验证 (tsc 错误计数对比基线)
- [x] Codex 双重审查 (交叉验证 mustFix/shouldFix)
- [x] 自修改重启 (safeBuild + exit code 75)
- [x] 计划对话 (PlanChatManager + ClaudeCodeSession)
- [ ] 大脑反思后自动更新 CLAUDE.md (框架就绪, 待运行验证)
- [ ] 深度链路审查 (每 5 个任务触发, 待运行验证)

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
       total_cost_usd, git_branch, start_commit, status, created_at

task_logs: id(serial), task_id(fk), phase, agent, input_summary,
           output_summary, cost_usd, duration_ms, created_at

daily_costs: date(pk), total_cost_usd, task_count

plan_drafts: id(serial), project_path, plan(jsonb), status,
             chat_session_id, chat_status, created_at

plan_chat_messages: id(serial), plan_draft_id(fk), role, content,
                    metadata(jsonb), created_at
```

停用表 (不删除, 停止写入): adjustments, memories, scan_modules, scan_results,
evaluation_events, review_events, goal_progress, prompt_versions, config_proposals

## 功能链路 (深度审查用)

### 自主循环
入口: `MainLoop.runCycle()`
路径: brainDecide → createTask → workerExecute(分支) → hardVerify → codexReview → brainReflect → mergeBranch
关注: 错误向上冒泡, 验证失败阻止合并, 费用追踪完整

### 任务执行
入口: `workerExecute(task)`
路径: ClaudeCodeSession.run(prompt) → 编码 → git commit → 返回 SessionResult
关注: timeout 处理, 成本追踪, sessionId 用于 workerFix 续传

### 硬验证
入口: `hardVerify(baselineErrors, startCommit, projectPath)`
路径: countTscErrors (对比基线) → getDiffStats (检查是否有实际变更)
关注: 基线错误数必须可靠, tsc 失败返回 -1 时不阻止合并

### 审查合并
入口: `mergeReviews(claude, codex)`
路径: 文件+描述匹配 → 交集提升为 mustFix → 只有 critical/high mustFix 阻止通过
导出: `mergeReviews()`, `extractIssueCategories()`, `countTscErrors()` (可测试纯函数)

## 设计原则

1. **失败必须可见** — 关键路径不允许 catch-ignore, 错误向上冒泡
2. **单一记忆源** — CLAUDE.md (规则/状态) + claude-mem (经验), 不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板, 让 session 用自己的工具链
4. **硬验证优先** — tsc + test 是唯一真实质量信号
5. **极简编排** — 编排器只做控制流, 不做 AI 推理
6. **端到端闭环** — 每条链路必须可测试验证

## 踩过的坑

- 嵌套运行 Claude: 必须清除 CLAUDECODE 等环境变量, 否则子进程拒绝启动
- postgres JSONB: 用 `sql.json()` 不要 `JSON.stringify()` + `::jsonb`
- evaluateTaskValue 失败默认 pass: 验证失败必须阻止合并, 绝不默认 pass
- 222 条 adjustments 全部 active: 数值化进化评分不工作, 改用自然语言规则
- 三套记忆系统互不通信: 统一为 CLAUDE.md + claude-mem
- Agent SDK permissionMode: 非交互场景必须用 `bypassPermissions`
- 1431 行 prompt 模板限制 Claude 能力: 删除所有模板, 让 Claude 自主推理
- patrol lock 自死锁: acquireLock/releaseLock 必须在 start() 的 finally 中
- 前端 innerHTML: marked.parse() 后必须过 DOMPurify.sanitize() 再赋值
- 空 git diff 应自动失败: 任务期望代码变更但 diff 为空时不能标成功
- `void asyncFn()` 反模式: 同步回调中用 `asyncFn().catch(handleError)` 替代
- 类型不要重复定义: import 已有类型而不是在本地重新派生, 类型漂移是静默 bug
- 清理函数改动时: 检查所有 class 级 Map/Set 是否都有对应的 .delete() 清理
