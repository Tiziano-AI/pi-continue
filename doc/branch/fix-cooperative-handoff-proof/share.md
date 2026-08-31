# 协作记录

- 分支：`fix/cooperative-handoff-proof`。
- 结论：Pi 0.84.4 在 Goal-first 与 Continue-first 两种加载顺序下，正常 Goal 协同压缩均完成唯一续接；强制让 Goal 的 `recordGoalUsage()` 或 `requestContinuation()` 静默返回 `false` 时，确实不会产生提示，属于可独立观测的协作握手失败路径。
- 实现：Goal 持有协作恢复责任，pi-continue 只验证压缩 proof、观察 Goal 提示或同回合宿主续行，不发送重复提示；Goal-owned `session_compact` 在宿主处理器返回后再执行 ledger/artifact/guide 副作用；输出写入受会话与事件代际保护；缺少外部提示时使用约 1 秒负确认窗口，宿主仍运行时允许有限续期，最终 fail closed。
- 回归：新增宿主边界释放、事件代际保护、同回合续行、无提示失败及活动宿主有界失败测试。
- 验证：`npm run typecheck`、`npm test`（293 项）、`npm run check:json`、`npm run check:pack`、`git diff --check` 全部通过。真实 Pi 0.84.4 / pi-goal 0.54.3 探针中，正常路径两种顺序各 10/10，延迟 1.5 秒处理器各 3/3；两条强制静默路径在两种顺序均记录单次 failed lifecycle，未发送 resume，约 1 秒级收束。
- Issue #11：已记录上述可复现的协作握手证据并保持问题开放；现有证据不足以把该路径与 Issue 中的 provider/原生压缩错误归为同一根因。
- 门禁备注：`corepack pnpm run gate` 仍受 Windows 嵌套 `pnpm` PATH 问题影响（Issue #25）；四个组成检查已直接通过。
- 诊断探针保存在 `F:/Temp`，不纳入仓库。
