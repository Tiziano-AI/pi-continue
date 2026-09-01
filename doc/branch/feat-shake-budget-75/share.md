# 协作记录

- 分支：`feat/shake-budget-75`。
- 目标：将机械摇树骨架预算默认值从上下文窗口的 20% 调整为 75%。
- 约束：保留超预算时回退 LLM 摘要的保护逻辑；同步默认示例与边界测试。
- 状态：默认配置、示例配置和边界测试已更新为 75%；超预算时仍回退 LLM 摘要。
- 验证：`corepack pnpm run typecheck`、`corepack pnpm test`（294 项）、`corepack pnpm run check:json`、`corepack pnpm run check:pack` 和 `git diff --check` 均通过。
