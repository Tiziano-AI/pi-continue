# 协作记录

- Issue：#16 支持按模型上下文百分比触发自动压缩；#17 修复测试继承本机全局 artifact 模式。
- 分支：`feat/context-percentage-threshold`。
- 决策：保留固定 `reserveTokens` 模式作为兼容默认；新增按当前模型 `contextWindow` 动态计算的百分比模式。
- 边界：百分比只控制自动 threshold；不改变 `keepRecentTokens`、摘要预算、手动压缩或 overflow 恢复。用量未知时放行 Pi 原生行为。
- 实现：统一解析器驱动 mid-run guard、turn-end 主动触发、原生 threshold 延后、settings、status、palette；百分比结果不写回共享 Pi 设置。
- 事件协调：百分比早于或等于 Pi 原生 token 边界时由 `turn_end` 触发一次插件压缩；百分比晚于原生边界时取消过早的原生 threshold，达到百分比后放行。
- 测试：配置、模型窗口重算、严格/包含边界、三种事件顺序、重复回合、null 用量、手动/overflow、settings 非改写、status 与 palette 已有覆盖。
- 门禁：原始 `gate` 已通过，typecheck、246/246 全量测试、JSON 校验和 51 文件 pack dry-run 全部成功；#15、#17 的 Windows/本机配置隔离问题已修复。
- 用户选择：提交后把本机全局配置切换为 90%，再通过新 Pi 进程验证。
- 下一步：提交功能，写入并验证本机全局配置，清理协作记录，关闭 Issue，合并主分支并删除功能分支。
