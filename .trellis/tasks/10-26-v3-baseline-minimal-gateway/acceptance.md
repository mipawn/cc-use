# Acceptance Evidence

日期：2026-10-26 17:25
分支：`feat/v3.14.2-gateway-relaunch`
基线：`v3.14.2`

## Automated gates

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，0 error / 3 条既有 warning |
| `pnpm test` | 通过（vitest + release-notes + cargo-build） |
| `cargo test -p cc-use` | 通过（全量集成测试） |
| `cargo test -p cc-use-daemon` | 通过（14 tests） |
| `cargo test -p cc-use-cli` | 通过（5 tests） |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy -p cc-use --lib` | 既有 clippy debt 不变；新增构造器已局部 allow，无新增告警 |

## Per-requirement evidence

### R1 网关出口

- `src-tauri/tests/gateway_api.rs`（17 tests）+ `db_proxy_sessions.rs`（6 tests）：
  - CRUD、单密钥绑定、key 归属校验、cleanup 保留 gateway、删除 key/provider 清理 gateway。
  - 停用网关 403；网关 token 转发到绑定 key；`count_tokens` 不被本地估算拦截。
  - `GET /v1/models` 转发上游而不是本地目录；gateway 行不出现在 `session_list`；两个网关可绑同一 key 且独立；绑定 Key 的固定模型映射不生效（客户端 model 原样转发）。
  - 模型发现复用供应商查询设置（`/v1/models`、查询 UA、authScheme）；推理路径从供应商 base 补 `/v1`；Key 配置的 authScheme/`proxyUserAgent` 生效；未设置转发 UA 时回退到查询模型 UA。
- `src/renderer/pages/GatewayPage.test.tsx`（3 tests）：列表/地址/绑定信息、启停调用、空状态。
- `src/renderer/api/__tests__/index.contract.test.ts`：gateway 命令与参数契约。
- 真实网关调用/换绑/停用/daemon 重启：自动化覆盖解析与转发；真实客户端调用待手工确认。

### R2 供应商配额 UI

- `Keys.query.test.tsx`（4 tests）与 `ProviderUsageWindows.component.test.tsx`（2 tests）通过。
- CSS 改动：`.providerQuota` 顶部间距、`.reset` margin、查询动作改为 link 按钮。
- 1024/1280/1440 视觉检查：**用户自行验证**。

### R3 Auto mode 兼容适配

- `cargo test -p cc-use --lib proxy::auto_mode`（7 tests）：默认只改 model、low 只设 effort、disabled 生效、auxiliary header 识别、未知输入透传。
- `apiKeyEditor.test.ts`（10 tests）：新 Key 默认关闭，模板显式值保留。
- 最新版 Claude Code 真实会话透传（`safeguards` / `safeguard_results` / `anthropic-beta`）：需要本机最新 CC 与真实凭据，**未在本轮执行**。

### R4 仅菜单栏

- Rust 编译、fmt、clippy 通过；Info.plist + Accessory + Reopen + 关闭即隐藏已实现。
- macOS 手工验收（Dock、菜单栏、关闭/重开、Finder/Spotlight、退出）：**用户自行验证**。

### R5 模型显式添加

- `ModelCatalogManager.component.test.tsx`（2 tests）：首次不预选、只提交用户勾选的模型。
- `KeyEditModal.component.test.tsx`（12 tests）通过。
- 真实交互流程：**用户自行验证**。

### R6 控制台异常真实性

- `proxy_console_errors.rs`（2 tests）：上游 401 显示 `upstream_error` + status + reason；200 截断流显示失败并写 `transport_error`。
- `handler.rs` lib tests（51 tests）：新增 pass-through SSE 无 log_ctx 时仍按 200 完成显示 OK；新增 armed guard 写一条 `transport_error`、disarmed guard 不写。
- `usage_parser.rs`（20 tests）：完成标记识别、截断流未完成、无尾换行的完成标记在 flush 后识别。
- `consoleFilters.test.ts`（11 tests）：cancelled 纳入异常视图、历史 ok+4xx 重新分类。
- `model_mapping.rs`（30 tests）：R3 新契约（low 只设 effort、thinking/max_tokens/temperature 保持原值）通过。
- 控制台四类异常的界面展示：**用户自行验证**。

## DeepSeek Harness / AgentRouter 实测（2026-10-26 19:00）

- DSH 的 OpenAI 发现请求是 `GET {baseURL}/models`。网关最终方案：客户端使用**网关根地址**；网关对 `GET /models`/`/v1/models` 复用供应商的「查询模型」逻辑（`/v1/models`、查询 UA、authScheme、分页），不再把 `/models` 原样转发到供应商官网。
- **真实端到端验证**（临时 HOME + 临时端口，不动用户运行中的 dev 服务）：
  - `GET /models` → `200 application/json`，返回 AgentRouter 模型列表（`gpt-5.6-sol` / `gpt-6-astra` / `gpt-6.1-sol`）。
  - `POST /responses`（空 body / 合法 body）→ 网关补 `/v1` 转发到 `/v1/responses`；合法请求返回 `200` Responses API 结果。
  - `POST /chat/completions` 对 `gpt-6-astra` 返回 400，提示该模型需改用 `/v1/responses`；这是模型/协议选择，不是网关路径问题。
- **UA**：AgentRouter 不带 Claude CLI UA 时返回 401；网关优先用密钥转发 UA，未设置时回退到供应商查询模型 UA（用户已配置 `claude-cli/2.1.161`），实测通过。
- **迁移修复**：旧的 `proxy_sessions` 启动回填会无条件把 `session_kind='gateway'` 改写成 `manual`，导致网关从页面消失。已改为一次性迁移 + 每启动幂等修复 gateway 行；新增 `reopening_the_database_keeps_gateway_rows` 测试。
- **DSH 复现“非 JSON”报错的真实原因（2026-10-26 20:08）**：页面报 `http://127.0.0.1:22345/models did not answer with JSON`，实测该端口返回 AgentRouter 官网 HTML。原因是 dev daemon 仍是 19:38 启动的旧进程，而新二进制 19:57 才构建；`lib.rs` 只在 `lastDaemonVersion` 变化时重启 daemon，dev 版本号不变所以沿用了旧进程。`launchctl kickstart -k gui/$(id -u)/com.mipawn.cc-use.dev.daemon` 后，同一请求返回 `200 application/json` 与真实模型列表；`POST /responses` 也按 `/v1/responses` 转发（返回上游 JSON 错误而非 HTML）。

## Docs / release

- `docs/v3.15.0/README.md` + 6 篇功能文档。
- `CHANGELOG.md` 增加 `[3.15.0]`。
- 版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 均为 3.15.0。
- 主 README / README_EN / guides/UI_WORKSPACE 同步。

## Not claimed

- 真实 Claude Desktop GUI、真实供应商额度查询未在本轮联调。
- 菜单栏窗口生命周期没有自动化测试，必须 macOS 手工验收。
- 最新 Claude Code 2.1.310 的 auto mode 透传结论来自官方文档，未做抓包对比。

## Review fixes (2026-10-26 17:35)

独立 `trellis-check` 审查后修复：

- Blocker：`model_mapping.rs` 仍断言旧的 `thinking.enabled` / `max_tokens=4096` 行为；已改为新契约（low 只设 effort，thinking/max_tokens/temperature 保持原值）。
- High：pass-through SSE 没有 `log_ctx` 时 accumulator 未被喂数据，导致完成流被误报为截断；已改为无条件喂 accumulator，并加 pass-through 流测试。
- High：流结束时先分类后 flush，最后一行无换行时 console 与 request_logs 可能不一致；已在分类前 flush 并补单测。
- Medium：网关仍受绑定 Key 的模型映射影响；新增 `RouteExecution.transparent`，网关跳过 `apply_model_mapping`，并加真实 mock 上游断言客户端 model 原样到达。
- Medium：WebSocket 客户端侧断开被报成上游错误；现区分 `WsRelayFailure::Client/Upstream`，客户端侧发 `cancelled`。
- Medium：取消 guard 新写入没有测试；已加 armed/disarmed 两条单测。
- Medium：网关测试补齐 `/v1/models` 透传、session_list 隔离、同 key 多网关、固定映射不生效。
- Medium：R2 查询按钮改为 link + 图标的断言已补。
- Medium：解压失败事件补真实 status。
- Blocker（真实 DSH 联调发现）：旧迁移每次启动都把 gateway 行改写成 manual；已改为一次性回填 + 幂等修复，并加回归测试。
- High（真实 DSH 联调发现）：网关对 OpenAI 路径注入 `x-api-key`，AgentRouter 需要 Bearer；已按路径选择鉴权头并加测试。
- High（真实 DSH 联调发现）：DSH 的 OpenAI 模型发现要求 Base URL 带 `/v1`；网关页现在同时展示 OpenAI（`/v1`）与 Anthropic（根地址）两个 Base URL。

## Working tree

所有改动尚未提交；等待用户确认后再进入 commit。
