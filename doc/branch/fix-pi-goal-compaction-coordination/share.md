# 协作记录

当前分支已完成第一版 pi-continue 与 pi-goal 协同压缩实现，正在处理真实 Pi 0.84.4 合成路径的时序与运行时依赖隔离。

已知设计约束：共享 `workflow:mutex:v1`；Goal 活跃时由 Goal 发送恢复提示，pi-continue 只验证 handoff；无 Goal 时保留单次 resume。受控中止使用运行时布尔状态，避免宿主替换消息时丢失 Symbol 标记。另一进程提示 Pi 0.84.4 的 `_replaceMessageInPlace` 会丢弃 Symbol 标记，因此不要恢复旧的消息内标记方案。

最新进展：已通过 `ctx.modelRegistry.complete` 优先使用宿主 provider registry，旧宿主再回退同包 `completeSimple`；真实 Pi 0.84.4 faux provider 合成与 Goal 完成验收均通过。补充了协议不可用时的独立运行回退，并修正 Goal 生命周期解析异常的 fail-closed 行为。当前工作区待最终门禁与提交。
