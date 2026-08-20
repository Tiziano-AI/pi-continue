# 协作记录

- Issue：#18 默认关闭压缩后的摘要面板；#20 隔离继承机器全局阈值模式的集成测试。
- 分支：`feat/compaction-summary-default-off`。
- 实现：`showAfterCompact` 的包默认值、README 和公开示例均改为 `false`；global/project settings 仍可显式切换为 `true`。
- 边界：默认关闭只抑制自动摘要面板；不改变摘要持久化、同会话续接、artifact 写入或 `/continue ledger` 手动查看。
- 测试隔离：固定 token 阈值与原生 adoption fixture 显式声明 `reserve-tokens`，不再继承开发机的 percentage 模式。
- 已验证：完整 `gate` 通过，包括 TypeScript、248 项测试、JSON 校验与 npm package dry-run。
