# 网关出口

日期：2026-10-26

## 目标

给外部或兼容工具一个稳定的本地入口：地址固定、Key 固定、绑定的上游密钥固定。网关只负责把请求原样转发到绑定的那一个密钥，不引入协议转换，也不要求客户端走 CLI 启动或会话令牌流程。

## 数据模型

- 一个网关 = 一条持久化的 `proxy_sessions` 行，`session_kind='gateway'`、`expires_at=NULL`、`cli_type=NULL`。
- 每个网关只绑定一个 `api_key_id`；可以创建多个网关，分别绑定不同密钥。
- 网关本地 Key 就是该行的 `session_token`（`session-…`），与现有临时会话令牌同一套解析。
- `display_name` 保存网关名称，`is_active` 控制启用/停用。

## 转发语义

- 客户端 Base URL 统一填网关根地址 `http://127.0.0.1:<proxyPort>`，API Key 填网关本地 Key。
- **模型发现**：网关对 `GET /models` / `GET /v1/models` 直接复用供应商已配置的「查询模型」逻辑：按供应商/密钥的 base URL、authScheme、查询模型 User-Agent、分页和 `/v1/models` 路径取回目录，再把原始 JSON 返回给客户端。客户端不需要自己拼 `/v1`。
- **转发**：网关按供应商 base URL 补全上游路径（与查询模型同一规则：base 不以 `/v1` 结尾且客户端路径不以 `/v1` 开头时补 `/v1`），例如客户端的 `/chat/completions` 转发到 `https://agentrouter.org/v1/chat/completions`。
- **鉴权**：使用密钥「连接配置」里的 authScheme；未配置时按客户端类型默认值（Claude Code 类为 x-api-key，Codex/Grok 为 Bearer）。网关不再按请求路径猜鉴权。
- **User-Agent**：优先使用密钥「连接配置 → 转发 User-Agent」；未设置时，网关回退到该供应商已配置的「查询模型 User-Agent」。两者都为空才保留客户端原值。
- daemon 解析网关 Key → 绑定的供应商 + 密钥，注入真实上游密钥后转发。
- 方法、查询串、请求体按客户端原样转发；路径只做 `/v1` 补全，不做协议互转。
- **`model` 也不改写**：绑定的 Key 上配置的模型映射对网关不生效，客户端发什么 model 就转发什么。
- `cli_type=NULL` 使网关跳过 Auto mode 分类标记和客户端类型校验；模型发现在网关内用供应商查询逻辑完成，推理路径由 `/v1` 补全规则处理。
- `count_tokens` 的本地估算对网关不生效：上游返回 404/405/501 时原样返回。

## 生命周期

- 网关由现有常驻 `cc-use-daemon` 承担，不创建新进程，也没有单网关启停。
- daemon 由 LaunchAgent（`RunAtLoad` / `KeepAlive`）和 30s watchdog 保持运行；网关页面在服务未运行时给出启动提示。
- daemon 重启后网关继续可用，无需重新创建。

## DeepSeek Harness 接入

DSH 的自定义供应商：

1. 在网关页复制出口地址：`http://127.0.0.1:<proxyPort>`。
2. DSH → 设置 → 模型 → 添加自定义供应商：
   - Base URL 填上面的网关地址（不需要加 `/v1`）。
   - API Key 填网关本地 Key。
   - API 协议按模型实际支持的接口选择。以 AgentRouter 的 `gpt-6-astra` 为例，它只支持 **OpenAI Responses**（`/v1/responses`），选 Chat Completions 会得到 400。
3. 点“获取可用模型”。网关会复用供应商页面已配置的「查询模型」逻辑，返回 AgentRouter 的模型目录。
4. 选择模型后保存。

已实测（2026-10-26）：

- `GET http://127.0.0.1:<port>/models` → 200 JSON，返回 AgentRouter 模型列表。
- `POST http://127.0.0.1:<port>/responses` → 网关补 `/v1` 后转发到 `/v1/responses` → 200 Responses API 结果。
- `POST /chat/completions` 对 `gpt-6-astra` 返回 400，提示该模型需改用 `/v1/responses`；这是模型/协议选择，不是网关路径问题。

## 失败与数据完整性

- 网关停用 → 403 `Gateway is disabled`。
- 新建/换绑时要求 Key 处于启用且未耗尽状态；绑定的密钥之后被停用/耗尽/删除 → 请求明确失败，不回退到其他密钥。
- 删除密钥或供应商时同步删除绑定它们的网关行，避免悬空出口。
- 真实上游密钥不出现在客户端配置、日志或响应中；网关本地 Key 按会话令牌同等对待。

## 验收

- 新建网关并绑定一个密钥后，用该地址 + 本地 Key 调用成功。
- 换绑另一个密钥后，同一网关请求走新密钥。
- 停用后请求明确失败；daemon 重启后网关仍可用。
- 多网关分别命中各自绑定的密钥。
