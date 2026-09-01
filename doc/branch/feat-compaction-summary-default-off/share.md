# 协作记录

- Issue：#18 默认关闭压缩后的摘要面板；#19 消除 percentage guard 与 Pi 原生阈值压缩的重复请求竞态；#20 隔离继承机器全局阈值模式的集成测试。
- 分支：`feat/compaction-summary-default-off`。
- 实现：`showAfterCompact` 的包默认值、README 和公开示例均改为 `false`；global/project settings 仍可显式切换为 `true`。
- 边界：默认关闭只抑制自动摘要面板；不改变摘要持久化、同会话续接、artifact 写入或 `/continue ledger` 手动查看。
- 测试隔离：固定 token 阈值与原生 adoption fixture 显式声明 `reserve-tokens`，不再继承开发机的 percentage 模式。
- 竞态方案：当前 token 已严格越过 Pi 原生阈值时，percentage guard 不调用 `ctx.compact()`，由紧随其后的 Pi threshold 事件处理；若 matching `session_compact` proof 已先落盘，迟到的 manual 错误回调按已完成收敛。
- 已验证：最终完整 `gate` 通过，包括 TypeScript、251 项测试、JSON 校验与 npm package dry-run；竞态回归覆盖原生接管和 proof 先于延迟错误回调两条事件顺序。
- 本机验收：全局 `showAfterCompact` 已显式设为 `false`；fresh Pi RPC 从开发 checkout 加载扩展，显示 percentage 90%（当前 258K 模型为 232,200 token）、摘要面板 `no`，并保持原生自动压缩开启。
