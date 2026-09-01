# 协作记录

- 目标：在保留重复压缩竞态修复的基础上，选择性接管 Pi 自然结束后的阈值压缩。
- 范围：只实现 native adoption、失败回退、独立 180 秒 synthesis 上限和回归验证；不复制 PR #14 的解析重试与 telemetry 重构。
- 当前阶段：已完成 opt-in 配置、自然回合资格检查点、采用所有权、原生回退、180 秒上限和焦点回归；正在执行全量验证与真实 Pi 0.84.2 canary。
- 已验证：TypeScript 类型检查通过；隔离环境中的配置、判定、运行时、扩展事件链焦点用例通过，成功路径只生成一个 v4 handoff 和一个 resume，失败路径释放给 Pi 原生压缩。
- Canary：Pi 0.84.2 实际 RPC 会话在项目级 `adoptNativeCompaction: true` 下触发 1 次 `threshold`，session entries 含 1 个 `pi-continue/v4` compaction（`continue-1`）和 1 条续接 prompt；最终 `agent_settled`，无 extension error、无 `Already compacted`，pending message 为 0。
- 非阻塞问题：Windows 测试断言未兼容反斜杠和 CRLF，已登记 upstream #15，本分支不混入无关修复。
