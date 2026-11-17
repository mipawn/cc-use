# 网关整流 Responses 跨资源历史

## Goal

中转把同一 `/responses` 会话分到另一个 OpenAI / Azure 资源后，上游会以「条目/密文不属于我」拒绝整轮请求，且该会话之后每轮都会失败。网关识别这类拒绝后，去掉资源绑定状态对同一上游重试一次，让会话可以继续。

## Requirements

- 只在 `/v1/responses`（含 `/responses`）路径生效；其他路径行为不变。
- 覆盖两种拒绝形态：HTTP 400/422/502，以及「先 200 + SSE、在第一个内容事件前用错误事件拒绝」。
- 供应商级开关 `responses_rectifier`（DB 列，默认 1），关闭后该供应商完全透传；开关随导出/导入往返。
- 只认上游自证的拒绝措辞（Azure 资源归属、`invalid_encrypted_content`、密文解不开、`was not issued to this caller`、`store:false` 下按 id 回查不到）；普通 400（模型名、参数错误）不重试。
- 清洗仅在发往上游的请求副本上进行：
  - 删除 `input` 中 `type=reasoning` 的条目；
  - 删除其余条目的顶层 `id`（`item_reference` 与只有 id/type 的引用保留）；
  - 删除条目及 `content`/`output` 片段里的 `encrypted_content`；
  - `include` 去掉 `reasoning.encrypted_content`。
- 正文、工具名、参数、`call_id` 关联、顺序保持不变；不改本地会话记录、不改客户端请求日志。
- 每个请求最多重试一次；正常请求（无资源绑定状态）不重试。
- 重试命中时：`log::warn!` 记录计数，响应带 `x-cc-use-rectified: resource-bound-state`。
- 拒绝体读取上限 1 MiB；读不出来按上游错误返回 502，不退化成静默放行。

## Acceptance Criteria

- [x] 单测：Azure 措辞（带中转前缀）、加密内容类拒绝被识别；无关 400/500 不识别。
- [x] 单测：清洗删除推理条目、顶层 id、`encrypted_content`、include，保留 `call_id`/参数/正文；幂等。
- [x] 集成测：mock 上游首次返回 Azure 400、二次 200 时，网关恰好重试一次，重试体不含 `rs_`/条目 id/`encrypted_content`，响应 200。
- [x] 集成测：无关 400 不重试；请求本身没有可清洗状态时不重试。
- [x] 集成测：mock 上游先 200 + SSE 报错、再 200 + 内容时，网关重试一次，客户端拿到内容且不含拒绝事件。
- [x] 集成测：供应商关闭整流后不重试。
- [x] 前端：供应商弹窗开关、TS 类型、i18n、组件测试与全量 vitest 通过。
- [x] `cargo test -p cc-use` 全量通过。

## Notes

- 目标是把 cc-switch 的 `opaque_state_rectifier`（#8877、#9424）思路搬到网关层，覆盖所有客户端（DSH、Codex、Claude Code），而不是只修某个客户端。
- 已知取舍：重试那一轮丢失历史推理状态（本来跨资源也带不过去），换来会话可继续。
- 流式探测上限 256 KiB：超限按正常流放行，避免为整流无限缓冲。
- `previous_response_id` 未做处理：本轮整流只删条目级状态，不推断服务端引用是否可用。
