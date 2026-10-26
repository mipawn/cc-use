# 控制台异常真实性

日期：2026-10-26

## 问题

- 非流式和流式响应无论状态码都发 `ok` 事件，控制台显示绿色“完成”，但 `request_logs.outcome` 已经是失败。
- 流式失败不保留原因；200 截断流只要先收到 usage 就被记为成功。
- 客户端中断只发 `cancelled` 事件，不落库，也不进入异常视图。
- 解压失败、Auto mode 分类器 200 无有效 envelope 等异常继续走“成功无 usage”的静默路径。
- 历史回放按已存储的 `kind` 着色，旧的 ok+4xx 仍然显示绿色。

## 改动

- 新增 `ConsoleEvent::upstream_response_error`，非 2xx 响应带真实 status + 截断后的上游错误消息。
- 流式结束按 `status + 完成标记 + usage` 判定：优先按状态分类，其次检查 `message_stop` / `response.completed` / `finish_reason` / `[DONE]`；2xx 未完成记为 `transport_error`。
- `StreamUsageAccumulator` 增加完成标记；截断流不再记为成功。
- `RequestCancellationGuard` 保存最小 log context；客户端中断时写 `transport_error` 行并保留 `cancelled` 事件。
- 解压失败返回 502 + `upstream_error`；Auto mode 分类器 200 无有效 envelope 记为失败。
- 控制台异常视图纳入 `cancelled`，并按真实状态着色；历史 ok+4xx 在展示时重新分类为 `upstream_error`。

## 验收

- 上游 401/429/500：控制台显示失败、状态码与原因，不显示成功。
- 连接失败：显示失败与原因。
- 200 后断流：显示失败（未完成），`request_logs.outcome=transport_error`。
- 客户端中途取消：显示取消与原因，并留下 `transport_error` 记录。
- 成功请求仍显示 ok。
