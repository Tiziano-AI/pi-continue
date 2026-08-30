# 协作记录

已完成 pi-continue 与 pi-goal 的 Workflow Mutex v1 协同压缩：Goal 持有工作流时由 Goal 负责恢复提示，pi-continue 仅验证 handoff proof；无 Goal 时保留单次 resume。补充了宿主 `ModelRegistry.complete` 路由、原生压缩完成证明、同回合续行识别、协议异常 fail-closed 与旧宿主回退。

验证：`npm run typecheck`、`npm test`（285 项）、`npm run check:json`、`npm run check:pack`，以及真实 Pi 0.84.4 faux provider/Goal 集成验收均通过。提交 `d250689`，已 fast-forward 合并到 `main`。
