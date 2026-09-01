# 协作记录

- 分支：`fix/tool-use-native-adoption-boundary`。
- 变更：原生阈值采用新增 `complete-tool-result-batch` 凭据；`turn_end` 仅在 assistant `toolUse` 的全部工具结果与 tool-call ID 精确匹配后建立检查点，判定层保留 30 秒新鲜度、配置、活动回合和可压缩准备校验。
- 回归：新增扩展事件链工具批次接管用例，并覆盖缺失/错误边界、一次性消费和不完整批次 fail-closed。
- 验证：`npm run typecheck`、`npm test`（294 项）、`npm run check:json`、`npm run check:pack`、`git diff --check` 全部通过；真实 Pi 0.84.4 standalone RPC 探针完成 `toolUse -> toolResult -> threshold -> pi-continue/v4 -> resume`，provider 3 次、单次 handoff/resume、无扩展错误。
- 诊断：Goal-first 与 Continue-first 真实探针此前均确认同一边界可接管；诊断文件保留在 `F:/Temp`，不纳入仓库。
