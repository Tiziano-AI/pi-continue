# 协同记录

已完成 Issue #26：在普通回合的 `before_agent_start`/`message_start` 边界失效尚未启动的 continuation，清理 deferred dispatch、计时器、输出写入和工作流所有权；已启动的同会话恢复与机械摇树恢复提示保持不变。

验证已通过：类型检查、全部 290 个测试、JSON 校验、打包 dry-run；Pi 0.84.4 真实宿主在两种扩展加载顺序下均先完成普通回合，再生成唯一的 Goal 新迭代，旧 `continue-1` 只进入失败终态且不再发送旧 resume。
