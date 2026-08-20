# 协作记录

- 目标：补齐 context mid-run guard 与 Pi 延迟压缩的协调，确保一次 handoff、一次压缩、一次 resume。
- 状态：实现与聚焦回归已完成。自动守卫在已有 compaction owner 时静默让出；仅当前 mid-run guard 主动中止产生的 abort-shaped assistant error 会在 `message_end` 改写为 `aborted`，从而阻止 Pi 的 post-turn 原生阈值重复压缩。
- 回归：覆盖 246577/258000（高于 232200 原生严格阈值）的 context -> 重复 context -> message_end -> turn_end -> session_before_compact -> 重复 session_compact -> 重复 callback 事件顺序；断言一次请求、一次通知、一次 resume 且无 warning/error。另覆盖无 owner、手动 owner、真实 provider error 及成功/失败清理边界。
- 验证：TypeScript 与 mid-run/runtime/index 相关 83 项测试通过；待完整 gate 与 fresh/reload Pi 进程验证。
- 约束：保留百分比提前阈值、原生接管、手动压缩、溢出恢复与 matching proof 的既有语义。
