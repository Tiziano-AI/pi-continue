# 完成摘要

- Issue #16 已实现：默认保留固定预留 token 模式，并新增按当前会话模型上下文动态计算的百分比模式。
- 百分比模式不会改写共享 Pi `reserveTokens`；手动压缩、overflow 恢复、`keepRecentTokens` 和摘要预算保持原语义。
- settings、status、palette、mid-run guard、turn-end 主动触发及原生 threshold 延后均使用统一阈值解析器。
- 原始仓库 gate 已通过：typecheck、246/246 测试、JSON 校验及 51 文件 pack dry-run 全部成功。
- Windows 门禁与本机全局配置隔离问题已修复，对应 Issue #15、#17。
- 本机全局配置已设为 percentage 90；新 Pi RPC 会话显示当前 258K 模型触发值为 232,200，解析器对 1M 模型计算为 900,000，Pi 原生自动压缩保持启用。
