# 协作记录

- 分支：`fix/cooperative-handoff-proof`。
- 诊断：真实 Pi 0.84.4 基线在 Goal-first 与 Continue-first 注册顺序均完成一次有效续接；故障注入证明两条静默路径会稳定触发现有错误：`recordGoalUsage()` 返回 `false` 或 `requestContinuation()` 返回 `false` 时，Goal 不提交提示，pi-continue 等待 30 秒后失败关闭。
- 当前判断：已确认可复现的静默拒绝路径，不等同于 provider 错误；仍需区分历史偶发的提示观察竞态，并设计不重复续接的显式握手/失败回退。
- 本分支尚未修改产品逻辑；诊断探针保存在 `F:/Temp`，不纳入仓库。
