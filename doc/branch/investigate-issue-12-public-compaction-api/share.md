# 协作记录

- 分支：`investigate/issue-12-public-compaction-api`
- 目标：为 Issue #12 建立受支持的 Pi 公共压缩 API 路径，避免复制或按文件系统加载宿主内部实现。
- 状态：调查完成；已创建上游提案并在 pi-continue Issue #12 留下迁移计划，本分支不修改运行时代码。

## 结论

- Pi 0.84.3 已从包根导出 `convertToLlm`、`serializeConversation` 与 `estimateTokens`，`ctx.getContextUsage()` 可替代阈值守卫对 `estimateContextTokens()` 的内部调用。
- `session_before_compact.preparation` 足以支撑实际摘要生成与原生压缩接管，但无法支撑无副作用的 `/continue preview` 和压缩启动前的可压缩性检查。
- 最小缺口是只读 `ctx.getCompactionPreparation(): CompactionPreparation | undefined`：它以当前分支和有效压缩设置生成调用时快照，不触发压缩、模型请求或会话变更。

## 上游路径

- 提案：`earendil-works/pi#8596`，https://github.com/earendil-works/pi/issues/8596
- 当前状态：按 Pi 新贡献者门禁自动关闭并标记 `untriaged`，等待维护者日常复核；收到维护者 `lgtm` 前不得创建实现 PR。
- pi-continue 跟踪：Issue #12 已链接该提案并记录逐项迁移与验收标准，https://github.com/Tiziano-AI/pi-continue/issues/12#issuecomment-5404614570

## 获批后的迁移

1. 从包根静态导入 `convertToLlm`、`serializeConversation`、`estimateTokens`。
2. 阈值守卫改用 `ctx.getContextUsage()?.tokens`，删除仅用于诊断的内部 usage/trailing 明细依赖。
3. 仅预览和压缩前检查使用新 getter；实际压缩继续使用事件自带 preparation。
4. 删除 `loadPiInternals()` 与 `pi-internals.ts`，不保留文件系统 fallback，也不增加宿主运行时依赖。
5. 将 Pi peer/dev 最低版本提升到首个包含 getter 的版本，并同时验证 Node 托管安装与 standalone binary。
