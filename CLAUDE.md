# db-coder

自主 AI 编码 agent。编排器 (Node.js) 驱动大脑和工人两个 Claude Code session 协作。

## 架构

```
编排器 (MainLoop, ~3200行)
  ├── 大脑 session (Agent SDK query(), 只读+记忆, 决策+反思+方案汇总+审查裁决)
  ├── WorkerAdapter (统一接口, Claude/Codex 可切换)
  │   ├── ClaudeWorkerAdapter (ClaudeCodeSession, 支持 resume)
  │   └── CodexWorkerAdapter (CodexBridge, 无 resume)
  ├── ReviewAdapter (审查接口, 自动与 Worker 互斥)
  │   ├── ClaudeReviewAdapter (只读 session 审查)
  │   └── CodexReviewAdapter (codex exec 审查)
  ├── 程序化 Hooks (PreToolUse/PostToolUse 观察)
  ├── 插件自动发现 (~/.claude/plugins/cache)
  ├── 硬验证 (tsc 错误计数对比)
  └── Web UI + API (SPA :18801)
```

核心循环: `brainDecide() → [workerAnalyze → reviewPlan → brainSynthesizePlan (M/L/XL)] → workerExecute() → hardVerify() → codeReview() → brainReviewDecision() → [workerReviewFix 循环] → brainReflect() → mergeBranch() → [chainScan] → [claudeMdMaintenance]`

## 环境

- PostgreSQL: `docker exec dev-postgres psql -U db -d db_coder`
- 构建: `npm run build` (npx tsc + copy web)
- 测试: `npm test`
- 服务: `node dist/index.js serve --project .`
- Node.js >= 22, TypeScript 5.7+

## 设计原则

1. **失败必须可见** — 关键路径不允许 catch-ignore, 错误向上冒泡
2. **单一记忆源** — CLAUDE.md (规则/状态) + claude-mem (经验), 不自建评分系统
3. **让 Claude 做 Claude** — 不写 prompt 模板, 让 session 用自己的工具链
4. **硬验证优先** — tsc + test 是唯一真实质量信号
5. **极简编排** — 编排器只做控制流, 不做 AI 推理
6. **端到端闭环** — 每条链路必须可测试验证
7. **始终进化** — 大脑每 cycle 必须产出任务，"nothing to do" 不可接受
8. **目标项目无关性** — db-coder 最终要扫描/编码任意项目，所有功能实现不能依赖目标项目的特定结构，必须从代码本身自动推导所需信息

## 踩过的坑

- 嵌套运行 Claude: 必须清除 CLAUDECODE 等环境变量, 否则子进程拒绝启动
- postgres JSONB: 用 `sql.json()` 不要 `JSON.stringify()` + `::jsonb`
- 验证失败绝不默认 pass: 验证逻辑必须在异常时阻止合并
- 前端 innerHTML: marked.parse() 后必须过 DOMPurify.sanitize() 再赋值
- 空 git diff 应自动失败: 任务期望代码变更但 diff 为空时不能标成功
- `void asyncFn()` 反模式: 同步回调中用 `asyncFn().catch(handleError)` 替代
- 类型不要重复定义: import 已有类型而不是在本地重新派生, 类型漂移是静默 bug
- 清理函数改动时: 检查所有 class 级 Map/Set 是否都有对应的 .delete() 清理
- 删除模块时必须 grep 文档目录确认无残留引用
- `JSON.parse() as T` 无运行时验证: 外部数据解析后用 `as` 断言, 畸形值直接透传。必须 typeof 检查
- 新增 error path 时必须审计所有状态通道: eventBus.emit/taskStore.addLog/返回值/控制标志
- SDK isolation mode 默认不加载任何设置: 必须设置 settingSources: ['user', 'project', 'local']
- SDK bypassPermissions 必须同时设置 allowDangerouslySkipPermissions: true
- SDK kill() vs timeout: exitCode -2 = manual kill, -1 = timeout, 用 killed 布尔标志区分
- 流式行解析 buffer flush: split('\n') + buffer 模式 close handler 必须 flush 剩余 buffer
