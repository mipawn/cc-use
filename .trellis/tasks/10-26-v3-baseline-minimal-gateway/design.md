# Technical Design

基线：`v3.14.2`（`feat/v3.14.2-gateway-relaunch`）。本设计只覆盖 PRD 的 6 项需求，复用 3.x 现有数据面，不引入 v4 的规则/模型三层模型。

## Architecture Constraints

- 数据面只有一个常驻进程 `cc-use-daemon`，Tauri 是控制面，不监听代理端口。
- 请求链路：`classify_request_auth` → `route_plan_with_codex_takeover_fallback` → `build_route_execution` → 原样转发。
- `build_route_execution` 是“凭据 → (provider, api_key, upstream_url, auth scheme, log ctx)”的唯一汇聚点。
- App 与 daemon 共用同一个 SQLite 文件（WAL），App 写入的行 daemon 立即可见。
- 真实上游密钥只在 daemon 内注入到上游请求；客户端只持有本地令牌。

## R1 网关出口

### 数据模型：复用 `proxy_sessions` 作为出口表

不新建第二套令牌解析。每个网关就是一条持久化的 `proxy_sessions` 行：

| 字段 | 值 |
| --- | --- |
| `session_token` | `new_session_token()` 生成的 `session-…`，即网关本地 Key |
| `provider_id` | 绑定的供应商 |
| `api_key_id` | 绑定的那一个密钥 |
| `project_id` | `NULL` |
| `cli_type` | `NULL`（关键：关闭目录拦截、Auto mode 适配和客户端类型校验，保持透明转发） |
| `session_kind` | `'gateway'` |
| `expires_at` | `NULL`（常驻，不因过期失效） |
| `revoked_at` / `revoked_reason` | `NULL` |
| `display_name` | 新增列，网关显示名 |
| `is_active` | 新增列，默认 1；停用后拒绝请求 |

多个网关 = 多条 `session_kind='gateway'` 行，每行只绑定一个 `api_key_id`。

**为什么复用而不是新表**：`resolve_session_resources` 已经完成了 provider/key 存在性、归属、启用、耗尽、过期、撤销、客户端兼容性校验；`build_route_execution` 已经完成了 base URL、认证方式、模型映射、日志上下文的构造。复用可以把改动限制在“识别 + 两个门禁 + 两个旁路”上，避免在 handler 里复制一份路由决策（spec 明确禁止）。

### 请求路径改动

1. `resolve_session_resources`：新增 `if !session.is_active { 403 }`；`session_kind='gateway'` 时消息为 `"Gateway is disabled"`，其他行为 `"Session is disabled"`。非网关行默认 `is_active=1`，行为不变。
2. `build_route_execution`：当 `session_kind == "gateway"` 时把 `cli_type` 强制为 `None`，不执行 `effective_session_cli_type` 的 `/v1/responses → codex-app` 推断。
3. 本地模型目录拦截（`GET /v1/models` 等）：现有条件要求 `cli_type` 为 `Some`，网关为 `None` 时自然跳过 → 请求转给上游。
4. `count_tokens` 本地估算：现有条件只判断路径和上游 404/405/501。增加 `route_execution.cli_type.is_some()`，网关不估算，直接返回上游响应。
5. `proxy_session_cleanup_stale`：`WHERE session_kind NOT IN ('desktop','gateway')`，避免常驻出口 30 天后被清掉。
6. `session_list`：过滤 `session_kind='gateway'`，避免网关出现在 CLI 会话列表；网关页走独立的 `gateway_list`。

`RouteExecution` 增加 `transparent` 标记（仅网关为 true），`apply_model_mapping` 在 `transparent` 时直接返回原始字节：绑定的 Key 上配置的模型映射对网关不生效，客户端发什么 `model` 就转发什么。这保证网关与页面文案“原样转发”一致。

**模型发现兼容**：网关对 `GET /models` / `GET /v1/models` **复用供应商的查询模型逻辑** `fetch_provider_model_catalog`：base URL、authScheme、查询模型 User-Agent、分页和 `/v1/models` 路径都由供应商/密钥配置决定，客户端使用网关根地址即可。转发路径由 `ensure_v1_path` 按供应商 base URL 补 `/v1`（与查询模型同一规则），不做协议转换。鉴权继续使用密钥连接配置的 `authScheme`，不按请求路径推断。User-Agent 优先使用密钥的 `proxyUserAgent`；网关未设置时回退到供应商的 `model-catalog-user-agent.{provider}.{kind}`，两者都为空才保留客户端原值。

不改：认证头替换、SSE 转发、WebSocket 转发、用量解析、request_logs 写入、console 事件、并发信号量。网关请求按自己的 token 占用每会话并发额度（16），与现有语义一致。

**数据完整性**：`proxy_sessions.api_key_id` 没有外键约束。删除密钥或供应商时必须同步清理绑定的网关行，否则会留下悬空出口：

- `api_key_delete` 删除密钥后，删除 `session_kind='gateway' AND api_key_id=?` 的行。
- `provider_delete` 级联删除密钥后，删除 `session_kind='gateway' AND provider_id=?` 的行。
- 只删网关行，不影响 managed/manual/desktop 会话。

### IPC / 命令

新增 `src-tauri/src/commands/gateways.rs`，注册到 `lib.rs::invoke_handler!`：

- `gateway_list() -> Vec<Gateway>`：join `providers.name` / `api_keys.alias`，按创建时间倒序。
- `gateway_create(name, provider_id, api_key_id) -> Gateway`：校验 key 属于 provider、provider/key 存在且 key 启用、未耗尽；生成 token；`session_kind='gateway'`、`expires_at=NULL`、`cli_type=NULL`、`is_active=1`。
- `gateway_update(session_token, name?, provider_id?, api_key_id?, is_active?) -> Gateway`：只允许更新 `session_kind='gateway'` 行；换绑时同样校验归属。
- `gateway_delete(session_token) -> bool`：只允许删除网关行。

`Gateway` DTO（`models/mod.rs` + `src/shared/types/index.ts` + `api/types.ts`）：

```
sessionToken, displayName, providerId, providerName,
apiKeyId, keyAlias, isActive, createdAt, lastSeenAt
```

不返回真实上游密钥。

### UI

- 新路由 `/gateway`，侧边栏 “管理” 组新增入口（`Sidebar.tsx`）。
- 页面结构：daemon 状态提示 → 网关列表 → 新建/编辑 Modal。
- 列表项展示：名称、供应商/密钥、出口地址 `http://127.0.0.1:<proxyPort>`、本地 Key（默认遮罩，复制/显示）、启用开关、编辑/删除。
- 新建/编辑：名称、供应商 Select、密钥 Select（按供应商过滤）、启用开关。
- 删除用 `Popconfirm`；复制用 `navigator.clipboard.writeText`。
- 数据加载：`useState` + `useEffect`，注册 `usePageRefresh`；失败 toast + `console.error`。
- i18n：`zh.ts` / `en.ts` 同步新增文案。
- daemon 未运行时显示可操作提示（启动服务），不静默改写用户的 `daemonEnabled` 设置。

“常驻”由现有 LaunchAgent（`RunAtLoad`/`KeepAlive`）+ 30s watchdog 承担；不为网关创建进程、不做单网关启停。

### 测试

- `src-tauri/tests/gateway_api.rs`：CRUD、key 归属校验、只操作 gateway 行、cleanup 不删 gateway。
- `src-tauri/tests/proxy_handler_auth.rs` 扩展：网关 token 解析到绑定 key；停用/撤销/密钥停用时 403；未知 token 401；`cli_type=None` 时不触发本地目录与 count_tokens 估算。
- `src-tauri/tests/route_plan.rs`：现有 session 令牌识别不变。
- 前端 `GatewayPage.test.tsx`：列表、创建、换绑、停用、复制、空状态。

## R4 仅菜单栏常驻

按 v4 `bc200fb` 的已实现模式移植到 3.x：

1. 新增 `src-tauri/Info.plist`：`LSUIElement = true`；`tauri.conf.json` 的 `bundle.macOS.infoPlist` 指向它。
2. `lib.rs` setup 早期：`#[cfg(target_os = "macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory);`
3. 删除所有 `set_dock_visibility` 调用：`lib.rs` CloseRequested、`tray.rs::toggle_window`、`commands/system_ext.rs::toggle_main_window`。只保留 `hide/show/set_focus`。
4. 新增 `tray::show_main_window(app)`：`show` + `unminimize` + `set_focus` + 刷新菜单。
5. `lib.rs` 从 `.run(generate_context!())` 改为 `.build(...).run(|app, event| ...)`，处理 `RunEvent::Reopen` → `show_main_window`。
6. 关闭语义：菜单栏模式下 `CloseRequested` 一律 `prevent_close()` + `hide()`，不再依赖 `closeToTray` 的 false 分支（否则最后一个窗口销毁会直接退出且没有 Dock 可唤回）。`Settings` 中 `closeToTray` 开关改为 `checked + disabled`，文案改成“菜单栏常驻模式下关闭窗口始终隐藏”，避免误导；设置存储本身保留，不做迁移。

风险与验证：

- Cmd+Tab 不再出现（Accessory 的预期行为）。
- 冷启动/开发未打包时可能有短暂 Dock 闪现已由 `LSUIElement` + setup 调用覆盖。
- 无自动化窗口生命周期测试，必须做 macOS 手工验收：无 Dock、顶部菜单栏存在、关闭后菜单栏可打开、双击 Finder/Spotlight 可重开、托盘退出可用。

## R2 供应商配额 UI

### 现状证据

- 供应商工作区实际是 `/keys`（`pages/Keys.tsx`），不是独立的 Providers 页面。
- 额度块：`Keys.tsx:815-846` → `ProviderUsageWindows`。
- 根因 1：`Keys.module.css:381-383` `.providerQuota { padding: 0 16px 14px; }` —— 顶部内边距为 0，额度区直接贴在 header 的下边框上。
- 根因 2：`ProviderUsageWindows.module.css:26-30` `.reset` 没有 `margin-top`，进度条与重置时间贴在一起。
- 根因 3：查询按钮 `Keys.tsx:832-844` 是 `.providerQuota` 下的裸 `<Button size='small'>`，只在“有查询脚本 + 无任何缓存”时出现；左对齐、默认权重、无图标/文案层级，和 header 右侧的图标刷新（`Keys.tsx:730-748`）重复且不一致。

### 改动

1. `.providerQuota` 改为 `padding: 14px 16px`（顶部补 14px），窄容器规则同步检查。
2. `.reset` 增加 `margin-top: 4px`；`.window` 不额外加 padding，避免单窗口时过度留白。
3. 查询动作归一：移除 `.providerQuota` 里的裸按钮；在额度区空状态使用与 header 一致的 `Button type='link' size='small' icon={<ReloadOutlined/>}`，文案用现有 `providers.queryNow`，右对齐或与空状态同列。保留 header 刷新图标作为有数据时的刷新入口，避免同时出现两个默认按钮。
4. 不改变 `handleRefreshBalance` / `providerStore.refreshBalance` / `balance_refresh` 链路。

### 验证

- `ProviderUsageWindows.component.test.tsx`、`Keys.query.test.tsx` 更新断言。
- 1024/1280/1440 宽度截图或 DOM 合同断言：5h 区块与 header 有稳定间距；查询动作不悬空、不重复。

## R5 供应商模型显式添加

### 现状证据

- 真正的模型添加入口是密钥编辑器的“模型映射”：`KeyEditModal.tsx:514-537` → `ModelMappingEditor.tsx` → `ModelCatalogManager.tsx`。
- 获取模型（`provider_model_catalog_preview`）只写临时状态，不落库；这部分已符合“获取不自动保存”。
- 混乱点：`ModelCatalogManager.tsx:93-95` 在首次拿到目录且 `selectionTouched=false` 时，把 `selected` 自动设为“全部供应商模型 + additions”。切到 custom 源时列表默认全选，用户看起来像“已经被添加”，但实际要按“应用 → 保存”才落库。
- 供应商级模型列表（`Keys.tsx` 的“查看模型”弹窗）是只读，不是添加流程。

### 改动

1. 删除 `ModelCatalogManager.tsx:93-95` 的自动全选；`selected` 只从已保存的 `value.models` 初始化。
2. 切换到 custom 源不清空、不自动全选；`selectionTouched` 只在用户显式勾选/取消后置位。
3. 明确两个动作：勾选/手动输入是“候选选择”，点“应用”写回密钥草稿，点密钥弹窗“保存”才落库；空选择时给明确提示，不默认全选。
4. 刷新获取结果只更新候选列表，不修改 `value.models`；已添加模型始终以草稿/数据库为准。
5. 不改变序列化格式 `version:2` 与 `catalog.mode` 语义，避免迁移。

### 验证

- `ModelCatalogManager` / `KeyEditModal.component.test.tsx` 更新：首次打开不全选；勾选后应用才变更；刷新不覆盖已保存列表；空选择不可保存或给出提示。
- 手工：全新密钥打开模型管理 → 无默认选中；勾选两个 → 应用 → 保存 → 重开只剩两个；再次刷新获取不改变这两个。

## R6 控制台异常真实性

### 现状证据（根因）

1. **非流式 4xx/5xx 一律发 `ok`**：`handler.rs:1006-1016` 无论状态码都构造 `ConsoleEvent::ok`；`ConsoleEvent::ok` 把 `kind` 硬编码为 `ok`（`console.rs:355-389`）。控制台显示绿色 ok，但 `request_logs.outcome` 是正确的 → 两套口径打架。
2. **流式 4xx/5xx 同样发 `ok`**：`handler.rs:2525-2535` 正常结束即 `ok`；`finalize_usage` 对非 2xx 且无 usage 的情况写成 `transport_error` + 通用文案（`handler.rs:2328-2335`），丢失真实状态和上游错误体。
3. **200 截断流被记为成功**：`finalize_usage` 只看 `billable + status`（`handler.rs:2309-2326`）；`StreamUsageAccumulator` 没有 `message_stop` / `[DONE]` / `response.completed` 完成标记（`usage_parser.rs:127-354`）。先收到 `message_start` 后断流的请求会被记为 `success`。
4. **流式失败原因丢失**：`handler.rs:2318-2325` 对 `client_error/upstream_error` 也传 `error_message: None`。
5. **客户端中断不落库**：`RequestCancellationGuard::drop` 只发 `cancelled` 事件，没有 log context，也不写 `request_logs`（`handler.rs:245-257`）。
6. **控制台分类只看 kind/status**：`Console.tsx:126-132` 的 `isProblemEvent` 不把 `cancelled` 算问题；颜色/标签按 `kind==='ok'` 判绿（`Console.tsx:62-77,401,418,525`），历史回放也保留错误 kind。
7. **Auto mode 200 分类器失败不可见**：分类器响应 200 但没有合法 Messages envelope/usage 时，MIME 不修复（`handler.rs:929-937`），随后走“成功无 usage 不写行 + 发 ok”（`handler.rs:961-983,1006`）。
8. **解压失败只 warn**：`decompress_limited` 失败仅 `log::warn!` 并置空（`handler.rs:911-923`），请求继续走成功路径。
9. **WebSocket 升级后错误仍显示 Upgraded**：`ws_relay` 只 debug 日志（`handler.rs:2861-2890`），没有终止事件/记录。

### 改动

**后端（按最小必要）**

1. 非流式：把 `handler.rs:1006` 的 `ConsoleEvent::ok` 改为按 `RequestOutcome` 分派；非 2xx 发新的 `ConsoleEvent::upstream_response_error`（新增构造器，带真实 status + 截断后的上游错误消息；现有 `upstream_error` 的 status 固定为 None，不能直接复用）。`request_logs` 已正确，不改口径。
2. 流式正常结束：`handler.rs:2525` 同样按 `ctx.status` 分派；非 2xx 发 `upstream_error` 并带错误消息。
3. `finalize_usage`：先按 status 分类，再决定 usage；非 2xx 带 usage 也要写 `client_error/upstream_error` + 错误消息，不再写成无原因的 `transport_error`。
4. `StreamUsageAccumulator` 增加完成标记：识别 Anthropic `message_stop`、OpenAI `[DONE]` / `response.completed`；2xx 且未完成时写 `transport_error` + `"Stream ended before completion"`，不发成功。
5. 客户端中断：给 `RequestCancellationGuard` 传入最小 log context（session/provider/key/model/request_id），drop 时写一条 `transport_error` + `"Client disconnected before response"`，并发 `cancelled` 事件；已 disarm 的请求不受影响。
6. 解压失败：返回 502 + `upstream_error`，写 `transport_error` 原因，不再静默继续。
7. Auto mode 分类器 200 无 usage/非法 envelope：写一条 `upstream_error` + 原因，避免“成功无记录”。
8. WebSocket 升级后失败：`ws_relay` 终止时发一次 `upstream_error`（带 close code/原因），可选写 `transport_error` 行。

**控制台 UI**

- `isProblemEvent` 纳入 `cancelled`、`upstream_error`、`rejected` 和 `status >= 400`（不新增 console kind；`transport_error` 是 `request_logs.outcome`，控制台统一用 `upstream_error` + 原因表达）。
- 颜色/标签按真实状态或 outcome 判定，不再用 `kind === 'ok'` 判绿。
- 行内摘要与详情显示 `status + error_message`，让原因无需开 detail mode 就能看到。
- 历史回放按已存储的 kind/status 显示，旧数据无法追溯的保持原样并在文案上区分“未知”。

**不做**：新增 `failure_stage`/`stream_completed` 列（本轮用 `outcome + error_message` 表达；若后续需要更细分类再加）；不改变 `gateway_request_events` 的 SQL 口径（它已经能按 status 重新分类）。

### 验证

- 构造：上游 401/429/500、连接失败、200 后断流、客户端中途取消、分类器 200 无 usage。
- 断言：控制台分别显示失败/取消与原因；`request_logs.outcome` 与 console kind 一致；成功请求不受影响。
- 单测覆盖 `handler.rs` 的 outcome 分派、`usage_parser` 完成标记、`Console.tsx` 分类。

## R3 Auto mode

### 最新版事实（截至 2026-10-26，Claude Code 2.1.310）

- Auto mode 已不是实验性开关：2.1.283 起是交互会话的默认权限模式；2.1.278 起在 `ANTHROPIC_BASE_URL` 指向网关时**默认请求服务端审查**。
- 服务端审查是**带内**的：普通 `/v1/messages` 请求体多出 `safeguards` 字段，`anthropic-beta` 多一个值；响应/SSE 多出 `safeguard_results`。不是单独的 classifier 调用。
- 只有 `CLAUDE_CODE_AUTO_MODE_SERVER=0`（或服务端明确不支持）时才回退到 Claude Code 自己的客户端分类器；该分类器默认模型是 Claude Sonnet 5，可用 `CLAUDE_CODE_AUTO_MODE_MODEL` 覆盖（2.1.302+）。
- 官方网关指南明确要求：`anthropic-beta` 原样转发、不按 allowlist 过滤；未知请求字段/响应字段（含 `safeguards` / `safeguard_results`）必须保留；不要重写 body、不要重建响应、不要改 tool-use ID；保留流和错误体。
- 当前 `auto_mode.rs` 只识别 2.1.220 的客户端分类器（system 前缀 + `<transcript>` + 无 tools），并把分类器请求的 `thinking` 强改为 `{"type":"enabled","budget_tokens":1024}`、注入 `output_config.effort:"low"`、删除 `temperature/top_p/top_k`。最新模型使用 adaptive thinking，`thinking.type.enabled` 可能直接报错；且这属于“无依据的改写”。

### 设计

#### 默认行为：完全不动 Claude Code 的请求

- 适配关闭（新 Key 默认）时：不注入任何 auto-mode 相关环境变量；代理不改 body；`safeguards` / `safeguard_results` / `anthropic-beta` 原样转发。
- `auto_mode.rs` 不进入适配分支；`apply_model_mapping` 现有的 model 映射仍按 Key 配置执行（这是 Key 的既有语义，不属于 auto-mode 适配）。

#### 开启适配（每 Key 的 `autoMode.enabled`）

1. **不注入启动环境变量**：`CLAUDE_CODE_AUTO_MODE_SERVER`、`CLAUDE_CODE_GATEWAY_HINT_HEADERS` 等都不动；Claude Code 自己决定走服务端审查还是客户端分类器。
2. **分类器/辅助请求识别**：
   - 有 `x-claude-code-request-class: auxiliary` 时优先使用。
   - 否则回退到 body 启发式：system 文本包含安全审查前缀、最后一条 user 消息带 `<transcript>…</transcript>`、`tools` 为空；把前缀匹配从 `starts_with` 放宽为 `contains`，降低新版措辞变化导致的漏识别。
3. **适配内容（只做最小必要）**：
   - `model`：配置了固定模型则用之；否则跟随当前会话最近一次带 tools 的非分类器请求的模型（现有缓存逻辑保留）。
   - `thinking`：默认（未设置）或旧值 `"preserve"` = 不改；UI 显示“不改（跟随 Claude Code）”。`"low"` = 只设置 `output_config.effort="low"`；`"disabled"` = `{"type":"disabled"}` 并移除 `output_config.effort`。
   - 不再改 `max_tokens`，不再删 `temperature/top_p/top_k`，不再强制 `thinking.type=enabled`。
   - 保留分类器响应 MIME 修复。
4. **默认值纠偏**：`apiKeyEditor.ts` 不再把新 Key 的 `autoMode.enabled` 强制设为 true；与 README、Rust 默认一致（默认关闭）。
5. **文案**：改为“Auto mode 兼容适配（仅不支持原生 auto 的供应商）”，说明开启后只把客户端分类器请求的模型映射到当前供应商；auto mode 本身由 Claude Code 控制，cc-use 不改变它的启动方式。
6. **兼容性**：已保存的 `thinking:"low"` 自动走新的安全实现；`"preserve"` 等价于不改；不做数据迁移。

### 验证

- 适配关闭：最新 Claude Code 经 cc-use 的 model/thinking/effort 原样；`safeguards`、`safeguard_results`、`anthropic-beta` 原样到达上游/客户端。
- 适配开启：不注入任何启动 env；客户端分类器/auxiliary 请求的 model 被映射；默认不改 thinking/effort；`low`/`disabled` 按定义生效；无 `thinking.type.enabled` 类 400。
- 单测：`auto_mode.rs` 的检测与改写、`model_mapping.rs` 的配置解析。
