# 实施验证记录（validation）

> 本文件由 Lead 在实施与质量检查后维护。工作包/T 编号对应 [implement.md](./implement.md)；
> 需求/验收对应 [prd.md](./prd.md)；实现契约对应 [design.md](./design.md)。
> 本轮未提交、未推送、未发布、未重启生产 daemon，也未修改 DSH 配置。

## 0. 基线与环境

| 项 | 值 |
| --- | --- |
| Git HEAD（实施前） | `e95c5b0`（工作区干净，仅任务目录未跟踪） |
| 实施后工作区 | **80 个已修改文件 + 12 个新增源码/测试文件**（另含任务目录与 evidence；`git diff --shortstat` = 11888 insertions / 2356 deletions），未提交 |
| macOS | 15.7.3 (24G419) |
| Rust | rustc 1.93.1 / cargo 1.93.1 |
| Node / pnpm | v25.1.0 / 10.20.0 |
| 基线（实施前） | `pnpm typecheck` 0；`vitest run` 34 文件 / 171 测试通过；`cargo test --workspace` 全通过（exit 0） |
| 测试上游 | 全程只用 `127.0.0.1` 本地 mock 上游（随机端口 + ready 信号），未调用真实供应商，未读取真实 Key |
| 数据库/日志目录 | 跨进程 E2E 使用临时 `HOME`（debug 数据目录 `com.mipawn.cc-use.dev` + `~/.cc-use`），生产目录未触碰 |
| 证据目录 | `.trellis/tasks/10-28-gateway-console-provider-ux/evidence/`（`evidence.json`、`evidence-lan.json`、`run_e2e.py`、`run_e2e_lan.py`、`mock_upstream.py`） |

## 1. 交付工作包

| 工作包 | 状态 | 主要文件 |
| --- | --- | --- |
| G-API 网关契约/迁移 | 已交付 | `models/mod.rs`、`db/mod.rs`、`db/proxy_sessions.rs`、`commands/gateways.rs`、`shared_runtime/gateway_connection.rs` |
| G-ROUTE 解析/发现/转发 | 已交付 | `shared_runtime/gateway_connection.rs`、`services/model_catalog.rs`、`commands/providers.rs`、`proxy/handler.rs` |
| G-UI 网关连接编辑 | 已交付 | `pages/GatewayPage.tsx` + css + test |
| M-UX 模型入口统一 | 已交付 | `pages/Keys.tsx`、`components/keys/*`、`hooks/useModelCatalogQuery.ts`、`pages/Keys.models.test.tsx` |
| Q-STATS 供应商线路质量 | 已交付 | `components/usage/ResourceUsageModal.tsx` + css + test |
| L-STORE writer/TTL/状态 | 已交付 | `services/console_log_store.rs`、`commands/console.rs`、`daemon/management.rs`、`tests/console_log_retention.rs` |
| L-IPC renderer 写入/恢复 | 已交付 | `api/consoleBus.ts`、`api/consoleStore.ts`、`api/consoleLogBridge.ts`、`main.tsx` |
| C-UI 控制台列表 | 已交付 | `pages/Console.tsx`、`pages/consoleFilters.test.ts`、`pages/Console.component.test.tsx` |
| SHELL 菜单/导航/说明 | 已交付 | `tray.rs`、`components/layout/Sidebar.tsx`、`WorkspaceLayout.module.css`、locales |
| REVIEW 集成自查 | 本文件 | Lead 审 diff + 全量门禁 + 跨进程 E2E |

共享文件由 Lead 独占维护：`src-tauri/src/lib.rs`（新增 2 个命令注册）、`src/shared/types/index.ts`、
`src/renderer/api/types.ts`、`src/renderer/api/index.ts`、`CHANGELOG.md`。冻结契约在派发前合入，
worker 未修改上述共享区（`git diff` 核对）。

## 2. T 编号测试证据

### Rust 侧

| 编号 | 入口 | 结果 |
| --- | --- | --- |
| T01 | `src-tauri/tests/db_proxy_sessions.rs` | 13 passed：旧 schema 升级、marker 重跑、非 NULL 不覆盖、非 gateway NULL、新装/无 gateway、损坏 JSON 回滚可重试、非法历史 URL/UA 保留（使用时才拒绝、错误不回显）、原 token/绑定/名称/启停/Key/provider 不变 |
| T02 | `src-tauri/tests/gateway_api.rs` | 29 passed（含 T02）：创建默认、整体替换、显式 null 清字段、省略保留、list 返回归一化对象、preview 只读 + 绑定/草稿校验且不写 DB |
| T03 | 同上 | 同一 Key 两个网关不同覆盖互不影响；Key 的 claude_code/codex clientConfigs 故意指向不同地址，`/models` 与推理都只命中网关/provider 有效配置；P0 缺陷回归 `gateway_discovery_and_inference_use_one_connection_not_client_configs` |
| T04 | 同上 + `services/model_catalog.rs` 内部单测 | `/models` 与 `/v1/models` 一致；根地址、`/v1`、`/relay`、query、IPv6、尾斜杠；空目录成功 vs 失败区分；分页/去重/上限 |
| T05 | `src-tauri/tests/proxy_websocket.rs`（3）+ gateway_api | 三种认证、UA 优先级、provider additive/模板、受保护/逐跳头阻断、HTTP/SSE/WS 捕获；WS 握手合法且消息 model 原样 |
| T17 | `proxy_handler_auth` 13 / `proxy_handler_console` 9 / `proxy_console_errors` 2 / `model_mapping` 28 | 非网关客户端路由、认证、映射、用量归属不退化；网关透明转发与生命周期保留 |
| T18 | `src/renderer/api/__tests__/index.contract.test.ts` 9 passed（新增 1 组契约用例） | 新命令 `gateway_model_catalog_preview`、`console_log_append_renderer`、`proxy_lan_addresses`、`console_log_read_recent/log_status/clear` 的 invoke 名称与参数形状被固定；`gateway_create/update` 的 connectionConfig 原样传递、省略字段不补 null |
| T21 | `gateway_api.rs` + `gateway_connection` 单测 | 本地 mock 经真实 handler：HTTP 成功、上游 400/500、传输失败、SSE 成功/取消各记录一次；request_id 唯一；providerId/apiKeyId 正确；同 Key 双网关不串扰；另一供应商/Key 不被污染；仅有测量才写 token/TTFT；`/models` 与 WS 握手不写计费推理；provider/Key 资源统计合计一致。未发现记录层缺口，因此未改写入逻辑 |
| T11/T12 | `cargo test -p cc-use --lib console_log_store` 24 passed | UTC→本地自然日边界（UTC+8）、今天/前两天保留/第三天淘汰、启动补扫、空闲 `recv_timeout` 维护、持续流量 append 前检查、offset 变化重计算、非法/未来时间计为损坏并物理淘汰、容量标志持久化、trimmed 持久化、日切不改 generation；旧混合文件逐条整理并保留 id/epoch/seq、全过期删除、活动文件受保护、损坏行计数跳过、唯一 temp+原子替换 |
| T13 | `src-tauri/tests/console_log_retention.rs` 6 passed | 独立 fd 的 flock 竞争/超时/释放后获取、持锁时 maintain 返回维护状态且 clear 失败数据完好、共享读与写锁、同来源两个 writer 双 epoch/双 active 均可回放、并发轮转不丢元数据、预算常量固定。**限制：同一测试进程内的两个独立 fd，不是 fork 子进程**（macOS flock 以 open file description 计，竞争是真实内核锁） |
| T14 | `crates/cc-use-daemon/tests/management_api.rs` 16 passed | 状态/clear token 认证保留；状态返回 per-owner 形状；clear 仅在文件真实消失后 200 且 generation 递增；并发 clear 代次正确 |
| T15 | `commands/console.rs` 内部 10 passed | 50 条边界、51 条整批拒绝；>64 KiB 整批拒绝；16 KiB 正文含多字节 UTF-8 边界；伪造 source 被强制 renderer；非法 id/level/timestamp/target/未来时间逐条 rejected 且合法项仍入队；队列满 rejected/dropped；磁盘失败 writeFailed；落盘脱敏；status camelCase 含 daemon unavailable |
| T16 | `api/consoleStore.test.ts` 14 + `api/consoleLogBridge.test.ts` 10 | 跨刷新 epoch 不重 ID、实时/回放同 ID 合并、终态不退回 pending、清空代次与在途批次、失败不递归/不无限重试、批次 50/64 KiB/16 KiB、缓冲区淘汰、单 IPC 在途、清空期间新日志进入下一代 |
| T20 | `cargo test -p cc-use --lib tray` 7 passed | 第一项固定 `open_main_window` 动作（无可见性 toggle）、旧 id 不再触发窗口动作；既有徽章日切、标题清空、Key 可用性用例保持通过 |

### Renderer 侧（Lead 复跑汇总；最终全量 40 文件 / 282 测试）

| 编号 | 入口 | 结果 |
| --- | --- | --- |
| T06 | `pages/GatewayPage.test.tsx` 20 passed | 连接摘要/地址/本地 Key/绑定保留；长说明移除（断言不再出现）；Base URL 草稿/默认地址提示/恢复默认；认证方式；UA；获取模型只读（不写 DB、不设默认模型/映射）；草稿值查询；旧响应隔离（改地址、切绑定、关闭重开）；保存完整 connectionConfig；校验不回显秘密 |
| T07 | `pages/Keys.models.test.tsx` 5 passed | 供应商入口与密钥入口收敛到同一控制器；第二次入口复用缓存（1 次网络请求）；强制刷新参数与首次一致；无 Codex/Grok 静默回退；多 Key 显式选择；无 Key 提示；首次点击趋势传入真实 providerId |
| T08 | `hooks/useModelCatalogQuery.test.tsx` 8 passed | 无凭据不发请求；同身份复用；慢 A 不覆盖新 B；旧身份错误丢弃；同身份刷新最新胜出；UA Apply 用当前值重查且不写偏好、不改 clientConfigs；身份含凭据/代理/Header 指纹且不含明文；缓存上限 32 / 5 分钟 |
| T09 | `ModelCatalogManager.component.test.tsx` 12 + `KeyEditModal.component.test.tsx` 19 | 拉取不自动勾选/不自动添加；应用只更新外层草稿；取消/失败/空结果保留已保存与手动模型；手动 ID 校验/去重；provider/append/custom 语义；连接页 Base URL 与查询共用草稿；恢复默认 |
| T10 | `utils/modelMapping.test.ts` 7 + `model_mapping.rs` 28 | provider/append/custom、角色、1M、映射、启动参数往返不变；查询偏好不写入转发 UA |
| T19 | `pages/consoleFilters.test.ts` 23 + `pages/Console.component.test.tsx` 13 | 请求/异常合并为一份列表；异常=rejected/cancelled/upstream_error/HTTP≥400；历史 kind=ok+4xx/5xx 显示失败；pending/WS 不误判成功；日志级别/来源/关键词交集且不混入异常请求；保留窗口/截断/每来源写状态提示；清空按来源结果展示 |
| T22 | `components/usage/ResourceUsageModal.test.tsx` 11 | 首次打开用点击 scope 查询；页面刷新重查并更新；范围/视图保留；延迟旧响应不覆盖新 scope；刷新失败保留旧数据并标记未更新；失败与空数据区分并可重试；关闭后不再查询/注销刷新 |

## 3. 完整门禁（最终 V9/V10，仓库根；R1–R8 全部完成并修复 check findings 后复跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 0 errors |
| `pnpm lint` | 0 | 0 errors，2 个既有 `react-hooks/exhaustive-deps` warning（`ModelEditorView.ts`，未新增） |
| `pnpm test` | 0 | vitest **40 文件 / 282 测试**通过 + `node --test` 脚本测试 6 通过 |
| `pnpm build:frontend` | 0 | 构建成功（既有 chunk 体积告警） |
| `cargo fmt --all -- --check` | 0 | 无格式差异 |
| `cargo test --workspace` | 0 | **607 passed / 0 failed**（42 个测试目标，含新增 T01–T26 用例） |
| `cargo clippy --workspace --all-targets` | 0 | 无 error（新增文件与新增测试的 clippy warning 已清零；仓库既有 warning 基线不变） |

## 4. 跨进程端到端测试（A13/A14/A16 的关键证据）

脚本：`evidence/run_e2e.py` + `evidence/mock_upstream.py`；结果：`evidence/evidence.json`，**34/34 检查通过**。

真实二进制：`target/debug/cc-use-daemon`（debug 构建、临时 HOME）。流程：
临时 HOME → 真实 daemon 首次启动完成建库/迁移 → sqlite 写入 1 个 provider + 1 把 Key（clientConfigs 故意指向
`legacy-claude` / `legacy-codex` 假地址）+ 2 个 gateway（同 Key；g1 = Bearer + UA 覆盖；g2 = Base URL 带 `/relay`
前缀 + x-api-key + UA 不覆盖）→ 启动本地 mock 上游 + 真实 daemon → 以外部 OpenAI 兼容客户端身份调用。

已验证（截断摘录，完整见 evidence.json）：

- `GET /v1/models` 返回上游目录；上游实际收到 `GET /v1/models?limit=1000`、`Authorization: Bearer sk-upstream-secret`、
  `User-Agent: E2E-Gateway-UA/1.0`（网关覆盖），**未**使用 Key 的 claude_code 地址/UA。
- `POST /v1/chat/completions`（非流式）200；上游收到 `model: mock-alpha` 原样、provider 自定义 Header、
  网关 UA；未命中 legacy 地址。
- `POST` 流式 200 `text/event-stream`，记录 `is_streaming=1` 且 usage=11/7（有测量才写）。
- 上游 400（`mock-error`）→ 客户端得到 400，request_logs 记 `client_error`（沿用既有 outcome 规则）一次。
- 网关二：`/relay/v1/models`、`/relay/v1/chat/completions` 路径前缀正确；`x-api-key` 认证且无 Authorization；
  无 UA 覆盖时保留入站 UA。
- request_logs：4 条推理请求全部归属 `p1/k1`，request_id 唯一；另一 provider/key 0 条污染；
  `/v1/models` 前后行数不变（非推理不写计费记录）。
- console 日志：daemon 日志文件存在且为 JSONL；管理接口 `log-status` 返回 per-owner 计数（available=true）；
  `console/clear` 返回 `{ok:true,...}` 且清空前文件真实消失（清空后新日志进入新 epoch 文件，符合设计）。
- 未覆盖：WS 握手在进程内集成测试（T05）验证；真实 DSH 桌面接入（H04）未执行。

## 5. A1–A17 验收台账

| PRD 项 | 自动化证据 | 手工补充 / 关键边界 | 状态 |
| --- | --- | --- | --- |
| A1 / R1 | T20（7）第一项固定打开动作、旧 toggle 失效；日切/徽章回归通过 | H01 四窗口状态、当前页/草稿、Dock 未执行 | **部分通过，手工未执行** |
| A2 / R2 | T06（20）长说明移除断言、必要操作/连接设置/故障提示保留 | H02 视觉检查未执行 | **部分通过，手工未执行** |
| A3 / R3 | T19（36）单一请求列表、异常分类交集 | — | 通过（自动化） |
| A4 / R3 | T19 日志三级筛选、详情复制、截断提示 | H02 复制/键盘手测未执行 | 通过（自动化） |
| A5 / R3 | T14–T16（16+14+10）三来源入队/恢复、稳定 ID、不递归；E2E daemon 日志落盘/清空 | 真实 Tauri 应用重启恢复未执行（jsdom+Rust 层面覆盖） | 通过（自动化，应用重启为未执行手工项） |
| A6 / R3 | T11/T12（24）日边界、启动/空闲维护、容量、旧文件、损坏行；T13（6）flock 竞争 | 真实跨午夜未执行（可控时钟）；T13 为同进程独立 fd | 通过（自动化） |
| A7 / R3 | T20 日切判定 + 徽章标题清空（纯函数）、T11 空闲维护、T16 内存过期剔除；“统计库未改动”为结构性保证（`console_log_store` 无任何 DB/rusqlite 依赖）而非断言 | H03 隐藏窗口真实午夜未执行 | **部分通过，手工未执行** |
| A8 / R4 | T07（5）+ T08（8）+ T09（31）同身份同候选、UA 重查、候选不自动添加、刷新保留 | — | 通过（自动化） |
| A9 / R4 | T08/T09/KeyEditModal 草稿地址、恢复默认、取消、旧响应隔离 | H02 交互手测未执行 | 通过（自动化） |
| A10 / R4 | T10（7+28）策略/角色/1M/映射/启动参数往返不变 | — | 通过（自动化） |
| A11 / R5 | T20 旁的 `components/layout/Sidebar.test.tsx`（3）：网关链接独立于管理与观测分组、观测分组含 /stats 与 /console、aria-current 仅当前路由；`App.tsx` 路由未改动 | H02 直达/刷新高亮手测未执行 | 通过（自动化；视觉为手工项） |
| A12 / 全部 | V8 全绿；新增 i18n key zh/en 配对（既有 11/3 漂移不变）；无秘密泄漏（E2E 仅使用假 Key，日志断言未输出真实凭据） | 中英文案人工走查未执行 | 通过（自动化） |
| A13 / R6 | 跨进程 E2E：外部客户端经网关获取模型并调用所选真实 ID；两路径同一连接 | H04 真实 DSH 桌面未执行 | **部分通过（mock 上游验证，真实桌面未执行）** |
| A14 / R6 | 跨进程 E2E：URL/auth/UA/Header/model 到达上游；T05 WS 握手；T03/T04 路径与目录 | — | 通过（自动化） |
| A15 / R6 | T01/T02/T06：升级保留 token/绑定/启停、不迁移映射；网关无模型选择控件；旧 schema 升级 | H02 升级安装手测未执行 | 通过（自动化） |
| A16 / R7 | T21（29 项含内）+ 跨进程 E2E：HTTP/SSE 成功/错误/取消各记录一次、归属正确、无非推理伪造、资源统计可读 | — | 通过（自动化） |
| A17 / R7 | T22（11）+ T07 首次点击 providerId、刷新重查、范围/视图保留、错误/空可区分 | H02 弹窗手测未执行 | **部分通过，手工未执行** |

## 6. 手工验收 H01–H05（未执行）

| 编号 | 状态 | 原因 / 后续步骤 |
| --- | --- | --- |
| H01 窗口入口 | not_run | 需要可交互 macOS 桌面：在隐藏/最小化/失焦/已打开四种状态点击徽章第一项，确认显示+聚焦且当前页/草稿保留；自动化只覆盖回调映射 |
| H02 界面交互 | not_run | 需要运行 `pnpm tauri dev` 或测试构建：网关连接/模型管理/控制台/侧栏/线路质量弹窗的深浅主题、滚动、复制、错误重试、直达与刷新高亮 |
| H03 留存恢复 | not_run | 需要测试构建 + 临时数据 + 可控时钟/真实跨午夜，以及刷新/重开应用读取历史、模拟容量/磁盘失败 |
| H04 DSH 外部客户端 | not_run | 需要用户授权配置测试 DSH 会话指向测试网关；本轮用本地 mock 客户端完成等价 HTTP/SSE 验收，不改用户既有 DSH 配置 |
| H05 局域网接入 | not_run | 需要第二台设备 + 测试构建：开启局域网后从同 Wi-Fi 设备用 `http://<LAN IP>:<port>` + 网关本地 Key 获取模型并发会话，确认 `/_management/*` 被拒、关闭后立即不可达、记录 macOS 防火墙提示；本轮用同一主机 LAN IP 跨进程 E2E 覆盖等价网络路径 |

## 7. 已知限制、风险与未覆盖

1. 跨进程 E2E 使用本地 mock 上游；真实供应商/真实 DSH 桌面未验证（H04）。
2. T13 的 flock 证据来自同一测试进程内两个独立文件描述符，不是 fork 子进程；macOS 上 flock 语义真实，但未增加独立子进程 harness。
3. 同一来源并发 writer 仅按“重启短暂重叠”处理：新 writer 不复用/不改写窗口内 closed 文件，但旧 writer 仍持有的 active 文件若已全部过期，可能被新 writer 启动整理，设计上记录而不以心跳文件彻底解决。
4. 读取在 500ms 内拿不到锁时降级为无锁读取（重命名/删除容忍），不阻塞请求转发。
5. `retention.corrupted` 为单次读取统计，trimmed/capacityEvicted 持久化；renderer 单条 >16KiB 在桥内截断并标记。
6. daemon 被禁用时 `console/clear` 返回 `{ok:false, daemon:false}`，界面显示“部分失败”；这是有意表达，不是 bug。
7. 迁移遇到绑定 Key 的 `client_configs` 为损坏 JSON 时会整体回滚并阻止启动（设计要求的失败回滚），需要修复该 Key 后重试；操作后果已在交付说明中标出。
8. 旧网关没有显式 claude_code 连接时迁移到 Bearer/供应商默认（消除隐式认证猜测的兼容变化），需在 CHANGELOG 说明。
9. `Api.provider.modelList` 在 renderer 侧已无调用方，但为避免跨层删改暂保留声明与 Rust 命令（不属于本任务清理范围）。
10. 真实 macOS 托盘焦点、菜单栏策略、跨午夜、视觉与键盘操作、真实 Tauri IPC 重启恢复、真实第二设备局域网访问均未在桌面执行（见 H01–H05），自动化部分单独记通过。
11. R8 的 `settings_update → proxy_restart` 自动重启调用本身需要 Tauri `AppHandle`，没有单元测试；“是否需要重启”的判定已抽出纯函数并有单测（`commands/settings.rs::listen_settings_require_restart`），重启失败的用户可见错误已在设置页实现，但设置页整体无页面级测试（H05 手工项覆盖运行态）。
12. `ConsoleLogLimits` 曾有未被读取的 `max_total_bytes` 字段，check 后已移除；100 MiB 全局预算现在由新增单测固定为“两个 50 MiB 来源预算之和”的不变量（`two_source_budgets_fit_the_total_log_budget`）。

## 8. 变更文件清单（工作区，未提交）

以 `git status --short` 为准：**80 个已修改文件 + 12 个新增源码/测试文件**（另有任务目录与 evidence）。按职责归类（均可在 `git diff --stat` / `git status` 核对，不再手动点名易漂移的清单）：

| 类别 | 文件 |
| --- | --- |
| Rust 主实现 | `models/mod.rs`、`db/mod.rs`、`db/proxy_sessions.rs`、`db/settings.rs`、`db/request_logs.rs`（测试字面量）、`commands/{gateways,providers,console,proxy,settings,codex_config,claude_desktop_config}.rs`、`terminal/mod.rs`、`services/{model_catalog,console_log_store}.rs`、`proxy/handler.rs`、`shared_runtime/{mod,gateway_connection,network}.rs`、`tray.rs`、`lib.rs`（注册，Lead） |
| Rust 测试 | `tests/{gateway_api,db_proxy_sessions,proxy_websocket,proxy_handler_auth,proxy_handler_console,proxy_console_errors,proxy_auth,user_agent,model_mapping,support/mod,db_settings}.rs`、`tests/console_log_retention.rs`（新）、`tests/proxy_lan_access.rs`（新）、`crates/cc-use-daemon/{src/management.rs,src/runtime.rs,tests/management_api.rs}` |
| Renderer | `pages/{GatewayPage,Settings,Keys,Console}.tsx`（+ 对应 `*.module.css`/`*.test.tsx`）、`pages/{Keys.models,Keys.query,consoleFilters,Console.component}.test.*`、`components/{keys/*,usage/ResourceUsageModal*,layout/Sidebar*,layout/WorkspaceLayout.module.css,settings/ProxyLanSection*}`、`hooks/useModelCatalogQuery*`、`api/{consoleBus,consoleStore,consoleLogBridge*,types,index}`、`main.tsx`、`utils/{modelQueryUserAgent,modelMapping*}`、`stores/settingsStore.ts`、`locales/{zh,en}.ts` |
| 跨层契约（Lead 独占） | `src/shared/types/index.ts`、`src/renderer/api/{types,index}.ts`、`src-tauri/src/lib.rs` |
| 文档 | `CHANGELOG.md`、`SECURITY.md`、`.trellis/spec/**` 受影响条目（见 §9、§12.4）、本文件、`evidence/` |

## 9. Spec 更新记录（Phase 3.3）

按 `trellis-update-spec` 判断：本轮涉及新命令、跨层 DTO、数据库迁移与基础设施（日志留存/锁），属于必须做 code-spec 深度的变更。已更新：

| Spec 文件 | 更新内容 |
| --- | --- |
| `backend/data-model-contract.md` | `GatewayConnectionConfig` 的「省略 / 整体替换 / 显式 null 清除」三态契约，`Gateway.connectionConfig` 归一化、`ProxySession.connectionConfig` 仅 gateway 有值 |
| `backend/database.md` | `proxy_sessions.gateway_connection_config` 列；`migrate_gateway_connection_config` 作为「列驱动的一次性数据迁移」范例（marker、只填 NULL、失败回滚、错误不含原始 JSON） |
| `backend/proxy-core.md` | 网关全部路径（`/models`、`/v1/models`、HTTP/SSE、WS）统一使用 `shared_runtime::gateway_connection` 有效连接；禁止读 clientConfigs/model-catalog UA 偏好 |
| `backend/architecture.md` | 控制台历史的 epoch/本地三天窗口/容量/每来源状态/renderer append/flock 维护 |
| `backend/errors-and-logging.md` | 三天 TTL 与容量双重边界；`console_log_append_renderer` 只返回入队计数、失败不得递归；per-owner 状态语义 |
| `frontend/api-bridge.md` | 新增 `gateway_model_catalog_preview` / `console_log_append_renderer` 命令与共享类型；移除已修复的 readRecent 内联形状漂移项 |
| `frontend/state-management.md` | consoleStore 的 retention meta/TTL prune/清空代次/持久化桥；模型查询控制器与旧 query-UA 只读种子的关系（`rememberQueryUserAgent` 已删除） |
| `frontend/data-and-ux.md` | 弹窗可在打开且有有效 scope 时条件注册 `usePageRefresh`，并要求 identity+revision+open 守卫 |
| `frontend/testing-and-quality.md` | 测试清单数量与新文件；Console 导出 helper 更名（`classifyRequestResult`/`projectRequestEvent`/`applyRequestFilters` 等） |
| `cc-use-daemon/backend/console-and-logging.md` | 每次进程启动新 epoch、三天 TTL 与维护时机、closed 文件整理、flock、per-source 状态、clear 真实 ack、renderer append |

未新增 spec 文件（现有分层已覆盖），未改动 `guides/`。R8（局域网访问）的 spec 增补见 §12.4。

## 10. 最终复核补记

- Lead 在 trellis check 中修复了 1 处 clippy `redundant_guards`（`shared_runtime/gateway_connection.rs` 认证默认值匹配），修复后 `cargo fmt --all -- --check` 与 `cargo test -p cc-use --lib gateway_connection`（12 passed）复跑通过，`cargo clippy --workspace --all-targets` 无 error。
- Lead 复核了跨职责的 10 个机械改动（`ProxySession` 新增必填字段导致的 `connection_config: None` fixture/构造点），均为 1 行、无行为变化，纳入最终 diff。
- 共享文件（`lib.rs` 注册、`shared/types`、`api` 两文件、`CHANGELOG`、`SECURITY.md`）仅由 Lead 修改；worker 未触碰（`git diff` 核对）。
- R8 集成时 Lead 追加 1 处实现偏差：地址收集过滤 `IFF_POINTOPOINT`（VPN/tunnel），并补单测；已回写 design §12.6 与 spec。
- 最终 V10 复跑（R1–R7 + R8 + 独立 check findings 修复后）：typecheck 0 / lint 0 errors / `pnpm test` **40 文件 282 测试** + 6 脚本测试 / build:frontend 0 / fmt 0 / `cargo test --workspace` **607 passed / 0 failed** / clippy 0 error。
- 两个跨进程 E2E 复跑：R1–R7 网关链路 **34/34**、R8 局域网链路 **19/19**（真实 daemon + 本机 LAN IP 192.168.31.128 + 临时 HOME）。
- 独立 trellis-check 后的补齐：新增 T18 契约测试（3 个新命令 + console 命令）、A11 侧栏渲染测试（3）、A20 重启判定纯函数单测（3）、`console_log_clear` 改 `spawn_blocking`、容量回收“删除成功才扣减”、删除未读取的 `max_total_bytes` 字段并以不变量单测固定 100 MiB、设置页重启失败改为可见错误；详见 §13。
- 遗留但不阻塞：`Api.provider.modelList` 已无 renderer 调用方（保留声明与后端命令）；`keys.modelList*` 等旧文案 key 暂未删除；设置页整体无页面级测试（H05 手工项覆盖运行态）；两者都记录在此，留待后续清理任务。

## 11. 结论

- 需求 R1–R8 的实现工作包全部落地；A1–A20 均有自动化证据，其中依赖真实 macOS 桌面/第二设备的 A1/A2/A7/A13/A17/A19/A20 标注“部分通过，手工未执行”；A11 已补提交的 Sidebar 渲染测试，转为通过（视觉仍为 H02 手工项）。
- 完整门禁与跨进程 E2E 全部通过；独立 trellis-check 给出 **PASS WITH ISSUES（无 blocker）**，其发现的问题已逐项修复或如实降级验证声明（§13）。
- 未提交、未推送、未发布、未重启生产 daemon、未修改 DSH 配置；提交与归档等待用户授权。

---

## 12. R8 局域网访问（2026-10-29 续接）

### 12.1 交付与安全边界

- 默认仍是 `127.0.0.1`；只有设置里显式选择「局域网」才绑定 `0.0.0.0`（`shared_runtime::network::proxy_bind_address`，仅精确小写 `lan` 生效，缺失/非法按 loopback）。
- 管理面与监听范围解耦：所有 `/_management/*` 由 `require_loopback_peer` 中间件守护，非回环对端在 token 校验之前即 403（含 console clear/SSE/log-status/detail-mode/instances），不会因开启局域网而暴露管理通道。
- 代理面：非回环对端的 `RequestAuth::ProviderCredential`（pass-through）返回 403 且不触达上游；gateway/session 本地 Key 正常；回环行为完全不变；缺少 `ConnectInfo` 仅出现在进程内测试，按可信处理。
- 地址发现：libc `getifaddrs`（无新 crate），过滤 loopback/link-local/0.0.0.0/组播广播/点对点 VPN，私网优先、去重、保留网卡名；新命令 `proxy_lan_addresses` 只读、不返回 token/路径；`IFF_POINTOPOINT` 过滤是实施偏差，已记录在 design §12.6。
- 设置变更（port 或 scope）自动重启 daemon；失败 log + 状态回读，不静默保留不一致状态。

### 12.2 测试证据

| 编号 | 入口 | 结果 |
| --- | --- | --- |
| T23 | `cargo test -p cc-use --lib network`（9 passed）+ `--test db_settings`（3 passed）+ `cargo test -p cc-use --test database_bootstrap` | scope 缺省/非法→loopback、`lan` 往返、写规范化；绑定函数 loopback→127.0.0.1 / lan→0.0.0.0；收集器过滤 loopback/link-local/0.0.0.0/组播/广播、私网优先、去重、保留接口名；`is_advertisable_interface_flags` 过滤 loopback/P2P；冻结 camelCase JSON 形状；真实 `getifaddrs` 冒烟（本机 192.168.31.128/en0） |
| T24 | `cargo test -p cc-use-daemon --test management_api`（21 passed） | 带 loopback ConnectInfo 的原行为全部保留；health/detail-mode/log-status/clear/SSE/instances 对非回环对端一律 403（即使 token 正确；token 错误也是 403，无法探测）；IPv6 非回环 403、`::1` 200；缺 ConnectInfo 的进程内测试按可信语义放行 |
| T25 | `cargo test -p cc-use --test proxy_lan_access`（8 passed）+ `proxy_auth`/`proxy_handler_auth`/`proxy_handler_console`（33 passed） | 非回环 provider 凭据→403 + console reject，响应不含凭据/管理字符串，且 Codex takeover 也不会被 LAN 利用；回环 provider 凭据语义不变；非回环 gateway/session Key 正常转发、`/models` 可取；缺 ConnectInfo 行为不变 |
| T26 | `pnpm exec vitest run src/renderer/pages/GatewayPage.test.tsx src/renderer/components/settings/ProxyLanSection.test.tsx`（28 passed） | 局域网开启时展示 LAN 入口并可复制、网卡名 Tag；关闭时一行提示跳转设置；无地址/加载失败有原因与重试；安全警告与“管理接口仅回环”说明存在；本地地址、卡片操作与创建/编辑未变 |
| E2E | `python3 .trellis/tasks/.../evidence/run_e2e_lan.py` | **19/19 通过**：真实 daemon + 临时 HOME + 本机 LAN IP（192.168.31.128）。默认 scope 下 LAN IP 连接被拒、回环网关 200；切 `lan` 重启后 LAN 网关 `/models`+推理 200、request_logs 归属正确；LAN 访问 management health/log-status/clear 全部 403、回环 health 200；LAN provider 凭据 403 且未触达上游、不泄漏凭据；关闭 LAN 后恢复仅本机、回环仍 200。证据：`evidence/evidence-lan.json` |

### 12.3 验收台账与手工项

| PRD 项 | 自动化证据 | 手工补充 | 状态 |
| --- | --- | --- | --- |
| A18 / R8 | T23 + LAN E2E（默认 scope LAN 不可达、回环正常；旧库缺字段按 loopback） | — | 通过（自动化） |
| A19 / R8 | T24/T25 + LAN E2E（LAN 网关可用；management 403；pass-through 403；回环管理 200） | H05 真实第二设备访问 | **部分通过，手工未执行** |
| A20 / R8 | T23/T26 + LAN E2E（持久化、变更重启、地址展示） | H05 视觉/防火墙核对 | **部分通过，手工未执行** |

| 编号 | 状态 | 原因 / 后续步骤 |
| --- | --- | --- |
| H05 局域网接入 | not_run | 需要第二台设备（同一 Wi-Fi）与测试构建：开启局域网后从第二设备用 `http://<LAN IP>:<port>` + 网关本地 Key 获取模型并发会话，确认网关可用、`/_management/*` 被拒、关闭后立即不可达、记录 macOS 防火墙提示。本轮以同一主机 LAN IP 跨进程 E2E 覆盖等价网络路径 |

### 12.4 R8 spec 更新

| Spec | 更新 |
| --- | --- |
| `cc-use-daemon/backend/runtime-startup.md` | 绑定改为 `proxy_bind_address(scope, port)`；`lan` 是唯一 0.0.0.0 例外；管理面/代理面守卫为强制项 |
| `cc-use-daemon/backend/quality-guidelines.md` | “禁止绑定 0.0.0.0”改为“只允许显式 LAN scope，且必须保留管理隔离与 pass-through 拒绝” |
| `cc-use-daemon/backend/management-api.md` | 新增 `require_loopback_peer` 传输层守卫、403 语义、与 scope 解耦 |
| `cc-use-daemon/backend/architecture-and-boundaries.md` | 监听地址来源与两模式下的边界 |
| `cc-use/backend/proxy-core.md` | 非回环对端拒绝 provider 凭据 pass-through；回环语义不变 |
| `cc-use/backend/data-model-contract.md` | `proxyListenScope` 仅精确 `lan` 生效、其余归一 loopback |
| `cc-use/frontend/api-bridge.md` | `proxy_lan_addresses` 命令与 `ProxyLanInfo` 形状、只读约束、设置更新触发重启 |
| `SECURITY.md` | 新增「局域网访问（可选，默认关闭）」安全说明与红线第 5 条 |

### 12.5 新增/变更文件（R8）

- 新增：`src-tauri/src/shared_runtime/network.rs`、`src-tauri/tests/proxy_lan_access.rs`、
  `src/renderer/components/settings/ProxyLanSection.tsx`(+css/test)、
  `evidence/run_e2e_lan.py`、`evidence/evidence-lan.json`。
- 修改：`models/mod.rs`、`db/settings.rs`、`commands/settings.rs`、`commands/proxy.rs`、
  `shared_runtime/mod.rs`、`proxy/handler.rs`、`src-tauri/src/lib.rs`（注册，Lead）、
  `crates/cc-use-daemon/src/runtime.rs`、`management.rs`、`tests/management_api.rs`、
  `tests/db_settings.rs`、`tests/database_bootstrap.rs`（如涉及）、
  `pages/Settings.tsx`(+css)、`pages/GatewayPage.tsx`(+css/test)、`locales/zh.ts|en.ts`、
  `stores/settingsStore.ts`（默认值，Lead 冻结）、`src/shared/types/index.ts`、
  `src/renderer/api/types.ts|index.ts`（Lead 冻结）、`CHANGELOG.md`、`SECURITY.md`、相关 specs。

### 12.6 已知限制 / 风险（R8）

1. IPv6 入口与指定单网卡绑定本轮不支持（设计明确）；daemon 在 `lan` 下只绑定 IPv4 `0.0.0.0`。
2. 点对点/VPN 网卡从展示列表过滤，但代理仍监听这些接口；若用户依赖 VPN 访问需手动使用地址。
3. 局域网为明文 HTTP，无 TLS；安全提示已明确，不承诺公网安全。
4. 真实第二设备、macOS 防火墙弹窗、跨 Wi-Fi 视觉核对为 H05 手工未执行项。
5. 真实场景下“端口被局域网其他程序占用”等 bind 失败仍走原有错误路径，未新增特殊处理。

---

## 13. 独立 trellis-check（2026-10-29）

用户追问是否执行过 trellis-check。此前 Lead 只按 `trellis-check` 清单自查并复跑门禁，未做独立复核；本轮补做：

- 形式：独立只读检查代理（fresh context，未参与实施），按 `.agents/skills/trellis-check` 执行全量检查；Lead 同步抽查高风险点。
- 结论：**PASS WITH ISSUES**——无 blocker、无安全漏洞，7 项门禁与两个 E2E 全部独立复跑通过且与声明数字一致（typecheck/lint/test/build/fmt/cargo test/clippy；34/34、19/19）。
- 安全检查逐项成立：管理面 8 条路由（含 SSE）全部被 loopback 中间件覆盖且先于 token 校验；非回环 provider 凭据 403 且不触达上游/不能利用 Codex takeover；`proxy_lan_addresses` 不返回 token/路径；网关三条路径（HTTP/WS/discovery）统一 `build_headers`，本地 session token 不会上游；迁移/校验错误不回显秘密；测试/证据仅假凭据。
- 跨层、DB、留存、异步健壮性、测试质量、spec 同步、scope 均通过。

### 13.1 findings 与处理

| 严重度 | 发现 | 处理 |
| --- | --- | --- |
| major | A20 声称“变更重启”有测试，但 `settings_update` 重启分支无任何测试（E2E 直接改库并自行重启 daemon） | 抽出纯函数 `listen_settings_require_restart` + 3 个单测（no-op/port/scope-only）；设置页在保存后读取 live 状态，重启失败显示错误而不是 success（新增 zh/en 文案）。A20 仍如实标注 partial：`settings_update → proxy_restart` 的 Tauri 集成调用需真实 AppHandle，未自动化 |
| minor | A11 无提交的 Sidebar 测试 | 新增 `components/layout/Sidebar.test.tsx`（3 测试：网关独立于管理/观测分组、aria-current、观测路由可达），A11 转 pass |
| minor | T18 契约测试未交付，validation 静默遗漏 | 扩展 `api/__tests__/index.contract.test.ts`：固定 `gateway_model_catalog_preview`、`console_log_append_renderer`、`proxy_lan_addresses` 与 console readRecent/status/clear 的 invoke 名称与参数；validation 增补 T18 行 |
| minor | `console_log_clear` 在 async 命令里阻塞 runtime 最多 5s | 改为 `tokio::task::spawn_blocking`，与 daemon 管理端一致 |
| minor | R8 PRD 要求重启失败可见，但 UI 仍提示成功 | 设置页保存后读取 `proxy.status()`，未运行则 `message.error(lastError \|\| 专用文案)` |
| nit | 验证清单数字过期（56/8、57 文件等） | §0/§3/§10 更新为最终 80 修改 + 12 新增、282 前端测试、607 Rust 测试；§8 改为按职责归类 |
| nit | clippy 声明“仅 1 处新增 warning”不准（新测试另有 4 处 `unnecessary_get_then_check`） | 修复为 `contains_key`，新增文件 clippy warning 清零 |
| nit | 容量回收先扣减后删除，删除失败可能提前结束回收 | 改为删除成功后才扣减 total |
| nit | `ConsoleLogLimits.max_total_bytes` 从未读取 | 删除死字段；新增不变量单测固定“2 × 50 MiB = 100 MiB” |
| nit | `useModelCatalogQuery` 注释写 UTF-8 实际是 UTF-16 code units | 修正注释 |
| nit | A7“统计库未改动”为结构性保证、未断言 | 在台账中如实写成“结构性保证（store 无 DB 依赖）” |

### 13.2 复核后门禁（修复完成）

- `pnpm typecheck` 0 / `pnpm lint` 0 errors / `pnpm test` 40 文件 **282** 测试 + 6 脚本 / `pnpm build:frontend` 0
- `cargo fmt --all -- --check` 0 / `cargo test --workspace` **607 passed / 0 failed** / `cargo clippy --workspace --all-targets` 0 error
- 两个 E2E 复跑：`run_e2e.py` 34/34、`run_e2e_lan.py` 19/19（证据 json 已更新）
- 未修复但已记录的 nit：同一来源并发 writer 的短暂重启重叠、真实 fork 级 flock 未做、H05/H04/H01/H03 桌面手工项。


## 14. R9 实施与验证（2026-10-30，本轮）

### 14.1 授权、基线与运行边界

- 用户明确要求“把我最新的 trellis 任务按照计划实施”，据此恢复已有 `10-28-gateway-console-provider-ux` 指针；未创建重复任务。
- 基线 HEAD `e95c5b0`、分支 `main`、93 个已有未提交路径；本轮保留原改动，不 reset、不提交/推送/发布/归档、不改 DSH、不安装或重启生产 daemon。
- pnpm 10.20.0、rustc 1.93.1；启动前 API 合约基线 9/9 通过。自动测试只使用合成 Key、mock 上游、TempDb/临时图标目录。
- write scopes：S 集成（主会话，TS DTO/API/locales/store/G UI/文档）、B（backend，Rust 清单/策略）、M（models，模型 UI/query）、O（observability，请求/日志/路由）、I（icons，图标 UI/helper）。共享注册由 backend 统一合入。

### 14.2 针对性验证（集成过程中）

- G 与 API：`pnpm exec vitest run src/renderer/pages/GatewayPage.test.tsx src/renderer/api/__tests__/index.contract.test.ts`，2 文件 32 测试通过（20 + 12）。默认全部/Bearer、无需网络查模、指定非空、清单故障保留旧 ID、绑定变更保留限制、取消不保存及 LAN 回归。
- O：Console/consoleFilters/Sidebar 42 测试通过；consoleStore/consoleLogBridge/Statistics/pageRefresh 31 测试通过。antd lint 0 issues。
- I：图标后端 helper 6 测试通过；ProviderModal/ProviderIcon/providerIcon 34 测试通过。
- 以上为迭代记录；最终完整门禁及 A21–A25 台账将在实现与独立复核完成后补充。jsdom pseudo-element 提示属于已知环境噪声。


### 14.3 独立复核与本轮修复

- trellis-check 已复核 B/G/I/O 及 M 主体，发现并修复：严格模式路径别名与实际上游地址不一致；旧无 ID 历史回放重复及匿名行索引漂移；清空后迟到历史恢复；保存中旧弹窗关闭新编辑器；映射候选名称被 ID 占位覆盖。
- provider 模式选择需要重开恢复，但不能变成运行时白名单/1M/角色配置：采用可选 `catalog.draftModels`，TS 往返用例和 Rust 三客户端目录/别名等价测试通过。
- 主会话接续最终检查时修正 Modal 的实际类型契约（使用 maskClosable），并用截图修正模型筛选 checkbox 换行、未查询却标“云端未返回”的文案与折叠/窄侧栏间距。
- 子代理在最终 M 测试/复核收尾时遇到服务用量上限；已落地修复由主会话完成最终类型/全量测试/构建/边界复查，未把代理异常当成功证据。

### 14.4 最终质量门禁

| 命令 / 范围 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | 通过，0 类型错误 |
| `pnpm lint` | 通过，0 error；仅 ModelEditorView.ts 两条原有 hooks warning |
| `pnpm test` | Vitest 41 文件 / 309 测试全通过；release-notes 6 + build 6 脚本测试通过 |
| `pnpm build:frontend` | 通过；保留原有大 chunk 提示，无打包/安装应用 |
| `cargo test --workspace` | 621 测试全通过（43 个 result groups，0 failed/ignored），包含 gateway_api 33、provider_model_catalogs 3、proxy_websocket 4 |
| 新增 draftModels Rust 等价回归 | 1/1 通过（model_mapping 三客户端目录、角色、别名和 1M 不变）；在上述全量之后增加，仅测试代码 |
| `cargo fmt --all -- --check` | 全量通过（含新增测试） |
| `cargo clippy --workspace --all-targets` | exit 0，保留现有仓库 warning；新策略/清单函数无新增 warning |
| changed antd lint | Gateway、Console/Activity、ProviderModal 与模型组件均 0 issues |
| `git diff --check` | 通过 |

- TCP mock 在默认沙箱中 bind 被阻止；Rust 网络测试获准在本机 loopback 测试环境复跑通过。未使用真实供应商或生产数据库。
- 本轮中英文新增 key 均配对；全库仍有既有 11 个英文缺失、3 个中文缺失，未扩大本轮范围处理无关文案。


### 14.5 浏览器视觉核对与验收台账

- 使用 `vite preview` 的本机静态构建与合成 IPC；阻止外部网络，不访问真实数据库/Key/图标。不是 DSH 替代服务，也不安装/启动 Tauri 或生产 daemon。
- 明/暗主题、1180 px 展开与 900/720 px 折叠/窄窗口核对；720 px 低于 Tauri 实际最小宽度 900，作为额外压力检查。请求真实 th/td，长 ID 在表格内滚动；页面根无横向溢出。
- 最终折叠侧栏实测 `/keys`、`/gateway`、`/logs`、`/stats`、`/console` 顶部分别为 381/424/467/510/553 px，均为 40 px 高、43 px 步距，高亮唯一。
- 截图见 [evidence/r9](./evidence/r9/)：gateway-light、gateway-dark-narrow、models-dark-narrow、console-dark-narrow、logs-dark-narrow、icon-confirm-dark。截图只含示例供应商/合成 Key。
- Chromium 开启 reduced-motion 仿真时既有 Dropdown 曾出现定位越界；恢复默认 motion 后下拉正常，键盘也能打开模型窗口。未修改既有全局动效策略；原生 WebView reduced-motion 情况仍需核对，不能把静态预览当原生通过。

| 验收项 | 本轮实现与新证据 | 尚未执行 |
| --- | --- | --- |
| A21 / R9.1 | Sidebar 测试；展开/折叠/窄窗口截图与实际坐标，统一间距/路由/高亮 | 原生 WebView |
| A22 / R9.2 | Keys/KeyEdit/Manager/query/modelMapping/store/API 与清单 DB 测试；独立模型窗口截图；provider draftModels TS/Rust 等价回归 | 原生重启/真实上游人工验证 |
| A23 / R9.3 | Gateway 21 测试、gateway_api 33、WS 4、策略 helper；实际 mock URL/Body、拒绝零命中、40 别名、已有 WS 策略变更与隔离；升级旧库与 revision | 真实外部客户端（未改 DSH） |
| A24 / R9.4 | Console 15、filters 23、consoleStore 16，桥/Statistics/pageRefresh 回归；真实 Table 与独立日志截图，回放去重/清空竞争修复 | 原生 WebView 滚动/复制 |
| A25 / R9.5 | ProviderModal 23、ProviderIcon 5、工具 6、Rust helper 6；图标删除确认截图，真实命令注册/API 合同 | 真实 WebView 文件交互（未删用户图标） |

### 14.6 交付状态

R9 五项实现及自动质量门禁已完成，相关规范/CHANGELOG/计划已同步。旧 R1–R8 作为回归基线通过现有测试。保留全部原有未提交路径；按明确边界不提交、不发布、不归档、不操作生产服务。任务保留 `in_progress`，等待原生人工验收和用户自行决定提交/交付时机。


## 15. R10 界面收敛（2026-10-30）

### 15.1 授权、基线与运行边界

- 用户指定继续 Codex 会话 `01a18a72-654c-7cc0-858c-ac8a2437c366`；用 `trellis mem context/extract` 恢复 33/33 轮对话，确认未完成的是 R10 界面收敛；最后澄清为用户明确确认“Key 里只保留选择和映射”，不再按可逆假设处理。
- 沿用任务 `10-28-gateway-console-provider-ux`；`python3 .trellis/scripts/task.py start ...` 恢复当前指针，不新建重复任务。
- 基线 HEAD `e95c5b0`、分支 `main...origin/main`、**121** 个未提交路径（R10 初次记录为 118，按本轮实际更新）；保留全部原有改动，不 reset/clean。
- 只改 renderer 源文件、对应测试、任务文档与证据；不变更 Rust/DB/IPC 合约、共享类型、网关严格策略、目录/角色/1M/启动参数/三日留存，不提交、推送、发布、归档，不重启生产 daemon、不改 DSH。自动测试与截图只使用合成 Key/供应商/网关/IPC 数据。

### 15.2 本轮修复与回归

续做前先跑 6 个模型/网关/控制台文件（112 用例），发现 **7 个失败** 均为既有 R10 收尾未完成：4 个 provider Desktop 角色推断、2 个 Key 旧 runtime 元数据角色断言、1 个网关保存 busy 所有权。证据 [resume-baseline-focused.log](./evidence/r10/resume-baseline-focused.log)。

| 问题 | 修复 | 回归 |
| --- | --- | --- |
| provider 模式重开会按 runtime ID 子串补出缺失/已清空的 Desktop 角色，与“仅恢复显式角色”相反 | [modelMapping.ts](../../../src/renderer/utils/modelMapping.ts) 先判定 catalogMode；provider 只采用显式 roles，append/custom 保留原 family 推断；旧 `providerRuntimeModels` 仍作为元数据快照 | [modelMapping.test.ts](../../../src/renderer/utils/modelMapping.test.ts) 4 个显式角色/清空用例 + 新增 append 角色与 1M 用例 |
| 网关保存后 `closeModal` 提前清 busy，且 `await load()` 后才结束 saving；迟到列表还可覆盖新结果/报旧错误 | [GatewayPage.tsx](../../../src/renderer/pages/GatewayPage.tsx)：`saving` 重入保护；写入结束即结束 busy，再关闭并触发非阻塞刷新；`load` 增加 `listRevision` 仅允许最新读取写入列表/错误/loading | [GatewayPage.test.tsx](../../../src/renderer/pages/GatewayPage.test.tsx)：busy 所有权、旧列表成功/失败迟到两回归 |
| 保存进行中仍可改 name/provider/key/baseUrl/policy/modelIds/auth/UA，提交后修改静默丢失 | 上述全部草稿控件加 `saving` 禁用；失败后恢复可编辑、保留草稿、不刷新列表 | [GatewayPage.test.tsx](../../../src/renderer/pages/GatewayPage.test.tsx)：锁控 + 失败恢复 + 保存按钮 loading 复位 |
| 900 px 打开日志详情时固定 380px 详情把消息列挤成 0，只能横向看到固定列 | [Console.tsx](../../../src/renderer/pages/Console.tsx) 列表/详情改为 `.streamLayout/.streamPane`；[Console.module.css](../../../src/renderer/pages/Console.module.css) 详情 `.detailPanel` 常规 380px，`<=1100px` 纵向堆叠（列表全宽、详情最高 45% 高） | 组件测试保持通过；合成浏览器实测结构/宽度（§15.5），未新增仅测 DOM 文本的假布局断言 |
| Key 内重复模型维护入口、Key 取消影响供应商目录 | 核对既有 R10 实现：`ModelCatalogManager` 仅由外层 `ProviderModelModal` 使用，Key 使用紧凑选择/映射；清单保存 disabled 与失败草稿恢复已落地 | [Keys.models.test.tsx](../../../src/renderer/pages/Keys.models.test.tsx) 13 用例、[KeyEditModal.component.test.tsx](../../../src/renderer/components/keys/KeyEditModal.component.test.tsx) 26 用例、[ModelCatalogManager.component.test.tsx](../../../src/renderer/components/keys/ModelCatalogManager.component.test.tsx) 12 用例通过 |
| Console 读取状态失败会遮蔽既有丢弃/写入失败计数 | 核对既有实现：读取失败作为并列 Tag 保留最后一次成功状态与 renderer 计数（未回退该行为） | [Console.component.test.tsx](../../../src/renderer/pages/Console.component.test.tsx) 相关 3 用例通过 |

- 清掉 [KeyEditModal.component.test.tsx](../../../src/renderer/components/keys/KeyEditModal.component.test.tsx) 一个未使用导入，修复本轮首次 `pnpm typecheck` 唯一错误；没有扩大行为改动。
- 本轮新增测试只使用 mock/合成 IPC；无真实上游、真实 Key、生产 SQLite 或 daemon 参与。

### 15.3 针对性门禁

| 命令 / 范围 | 结果 |
| --- | --- |
| `pnpm exec vitest run` 6 个改动相关文件 | 6 文件 / **116** 用例全通过（日志 [resume-focused-after-fixes.log](./evidence/r10/resume-focused-after-fixes.log)） |
| `pnpm exec eslint` 改动源/测试 5 文件 | exit 0（[resume-eslint-changed.log](./evidence/r10/resume-eslint-changed.log)） |
| `NO_UPDATE_CHECK=1 antd lint <file> --format json`（GatewayPage/Console/modelMapping） | 每文件 0 issues（[resume-antd-lint.log](./evidence/r10/resume-antd-lint.log)） |
| `pnpm exec prettier --check` 全部本轮改动源/测试 | 通过（[resume-prettier-check-2.log](./evidence/r10/resume-prettier-check-2.log)） |
| `pnpm typecheck` | 通过，0 错误（[resume-typecheck-2.log](./evidence/r10/resume-typecheck-2.log)） |

### 15.4 完整质量门禁

| 命令 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | 通过，0 类型错误 |
| `pnpm lint` | 通过，0 error（[resume-lint-full.log](./evidence/r10/resume-lint-full.log)） |
| `pnpm test` | 41 文件 / **340** 用例全通过；release-notes 6 + build 6 脚本通过（[resume-full-tests.log](./evidence/r10/resume-full-tests.log)） |
| `pnpm build:frontend` | 通过；仅既有大 chunk 提示，无打包应用/安装（[resume-build-frontend.log](./evidence/r10/resume-build-frontend.log)） |
| `git diff --check` | 通过 |
| Rust / DB / daemon 门禁 | 本轮无跨层改动，未重跑；R9 的 621 Rust 测试与 1 条等价回归仅作历史基线，不作为 R10 新验证 |

- 未运行 `dev:daemon`、真实 Tauri 打包/安装、生产 daemon 重启或任何提交/发布步骤。

### 15.5 合成数据视觉核对

- 构建 `dist` 后用 `vite preview --port 4173` 本机静态服务；Playwright 通过本机已安装 Google Chrome 驱动，脚本在 [.playwright-mcp/r10-review-ui.mjs](../../../.playwright-mcp/r10-review-ui.mjs)，所有非 loopback 请求 `route.abort()`，Tauri IPC 由合成 fixture 响应。不是 DSH 替代服务，也不是原生 WebView 验证。
- 覆盖 1440×960 明/暗主题与 900×700 最小窗口；请求/日志各 2/8 行合成记录，Key/供应商/网关/模型清单均为合成示例。
- 实测：900 px 时 `console-content` 的 `flex-direction: column`，列表与详情宽均 **640 px**，详情位于列表下方；日志消息列最小 **194 px**（不再被固定 380px 详情挤为 0）；`documentOverflow=false`，暗色 `data-theme=dark` 生效；无 pageerror、无 console error。网关编辑弹窗分组为“连接设置/模型暴露”，模型窗口标题“查看模型”且弹窗内无“管理模型”重复入口。
- 截图（[evidence/r10](./evidence/r10/)）：`r10-console-requests-light`、`r10-logs-light`、`r10-logs-detail-900`、`r10-gateway-light`、`r10-gateway-editor-light`、`r10-keys-light`、`r10-models-light`、`r10-logs-dark`、`r10-logs-detail-900-dark`、`r10-gateway-900-dark`、`r10-models-900-dark`；指标 JSON 见 [resume-visual-check.json](./evidence/r10/resume-visual-check.json)。
- Chromium 只是静态构建 + 合成 IPC；不能替代原生 WebView、真实滚动/复制、真实上游/第二设备或真实图标文件交互。

### 15.6 未执行的人工验收与限制

- 原生 Tauri WebView 在最小窗口/缩放下的人工核对未执行；`reducedMotion` 仅在 Chromium 仿真。
- 真实供应商模型查询、真实 Key、真实上游、真实 WebSocket/外部客户端、真实第二设备、真实图标上传/删除未执行。
- R10 继续沿用用户边界：不自动提交、推送、发布、归档任务；任务保持 `in_progress`，等待用户决定提交与原生验收时机。

### 15.7 A26–A28 台账

| 验收项 | 本轮实现与新证据 | 尚未执行 |
| --- | --- | --- |
| A26 | Key 无“管理模型”维护 UI；`ModelCatalogManager` 仅外层使用；外层完成查询/新增/重命名/移除/1M/保存；Key 选择与映射只改草稿；取消 Key 不影响已保存清单（13+26+12 用例） | 原生 WebView 手工点击 |
| A27 | 搜索/有名称筛选/操作分区；状态摘要与异常/截断/丢弃/写入失败并列；三页独立筛选与全局清空不变；900px 详情响应式堆叠，消息列 194px（Console 18 用例 + 合成截图） | 原生 WebView 滚动/复制、真实 second-device |
| A28 | 网关连接/模型暴露分组、高级折叠、保存锁控与失败恢复；模型窗口清单为主体、查询连接/高级参数分层；明暗/长 ID/900px 截图 | 原生 WebView、真实上游查询 |

### 15.8 独立复核

- 只读复核者（`r10-reviewer`）审读最终工作区后结论：**无阻断性发现**。复核未修改文件、未启动服务、未运行浏览器；范围为本轮 renderer 新增符号与对应测试。
- 已验证通过：provider 模式仅恢复显式 Desktop 角色、append/custom 保留推断（[modelMapping.ts](../../../src/renderer/utils/modelMapping.ts) 与测试）；`providerRuntimeModels` 仅 renderer 快照、Rust 只读 `catalog.models` 且忽略 `draftModels`；网关 `save` 重入/失败保留草稿/先结束 busy 再关闭刷新、`listRevision` 防迟到列表、全部草稿控件 `saving` 锁定；Console 状态读取失败与旧计数并列、900 px 详情面板断点/类挂载结构正确。
- 复核发现的残余项（均非阻断，未在本轮扩大修改）：
  - `consoleStore` 清空部分失败时复用了“历史记录读取失败”通道（[consoleStore.ts](../../../src/renderer/api/consoleStore.ts)、[Console.tsx](../../../src/renderer/pages/Console.tsx)），提示可能与 clearPartial 重复；属 R9 之前的既有错误通道，非本轮引入。
  - 移除 Key 模型维护后留下若干未使用的 i18n key（`keys.manageModels`、`keys.addToModels`、`gateway.fetchModels` 等，中英成对）与 `Keys.tsx` 注释/恒为 `'usage'` 的 `keyEditTab` 残留；不接触用户数据，保留以免无关文案变更。
  - `ProviderModelModal` 的单 Key 预填只在挂载时读取；若打开窗口时 Key 列表尚未到达，需等列表刷新或手动选择（既有行为）。
  - 复核者原怀疑 grok 会把 provider 快照误写入 catalog；核对 [modelMapping.ts](../../../src/renderer/utils/modelMapping.ts) 后确认 grok 分支只写 `model`/`upstream`、从不写 `catalog`，该条不适用，无改动。
- 复核者列出的测试缺口（A27 详细模式点击/失败回滚、路由往返断言实际 select 值、窄屏布局自动化、保存双击、模型窗口保存中 Escape）未在本轮补齐；窄屏由合成浏览器实测覆盖，其余留作后续回归增强。
- 复核意见中“implement/validation/task.json 仍是 R9 占位”的文档项已在复核后更新为本 §15；本条之外的代码结论与最终工作区一致。



## 16. R10 二次反馈修订（2026-10-31）

### 16.1 授权与决策

用户对 R10 首轮结果提出 5 项反馈。主会话先确认了会改变行为的分歧，最终选择：

- Key 去掉“模型目录来源”，勾选模型改为“只开放所选模型”（白名单），清空则恢复供应商完整目录；
- 删除独立“运行日志”页，日志并入控制台；
- 控制台恢复终端风格并跟随浅/深主题；
- 网关默认鉴权保持 Bearer（R8 既有创建默认）；
- “查看模型”改名为“模型清单”。

仍沿用任务 `10-28-gateway-console-provider-ux`，只改 renderer、对应测试、locale 与任务文档；不提交、不推送、不归档、不发布，不操作生产数据/daemon，不改 Rust/DB/IPC/共享类型。

### 16.2 实施内容

| 反馈 | 实现 |
| --- | --- |
| 1. 供应商密钥去掉模型目录来源 | [ModelMappingEditor.tsx](../../../src/renderer/components/keys/ModelMappingEditor.tsx) 删除 `catalogMode` 下拉与三模式说明；模型多选改为“可用模型”：勾选后写 `custom` + 所选 models（运行时白名单），清空写 `provider`（完整供应商目录）。未改选择时旧 provider/append 配置保持原模式；R10 遗留的 provider draft 不再显示为已勾选（该模式运行时本就忽略选择），旧缺失 ID、1M、Desktop 角色仍保留。提示文案改为“仅向该客户端开放所选模型；清空选择则恢复供应商完整目录”。 |
| 2. 运行日志页 | 删除 `/logs` 路由、侧栏入口、标题映射与 `Logs.tsx`/`observationState.tsx`；日志作为控制台的“运行日志”tab，持久化与三日清空仍走原 store。移除 R10 的独立筛选下拉、状态标签带、录制状态弹层与日志详情。 |
| 3. 控制台格式与主题 | [Console.tsx](../../../src/renderer/pages/Console.tsx) 恢复终端单行流：请求/异常/运行日志三 tab，请求行等宽单行、日志行 `[time] LEVEL target: message`；搜索、详细模式、暂停/继续、刷新、清空、请求详情保留。颜色全部改由 `theme.useToken()` 提供，浅色主题浅底、深色主题深底，不再固定深色。 |
| 4. 网关默认鉴权 | 默认仍为 Bearer，不改变创建/保存语义；首轮曾加 Bearer/x-api-key 说明，按用户后续反馈已删除，界面不再显示该文案。 |
| 5. 模型入口名称 | zh `keys.viewModels` 改为“模型清单”、en 改为 “Model catalog”；Key 内提示、网关提示与清单弹窗标题同步更新。 |

### 16.3 回归与门禁

| 命令 / 范围 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，0 错误 |
| `pnpm lint` | 通过，0 error |
| `pnpm test` | 41 文件 / **330** 用例全通过；release-notes 6 + build 6 脚本通过（[r11-full-tests.log](./evidence/r10/r11-full-tests.log)） |
| `pnpm build:frontend` | 通过，仅既有大 chunk 提示（[r11-build-frontend.log](./evidence/r10/r11-build-frontend.log)） |
| changed antd lint（Console/Gateway/ModelMappingEditor/ProviderModelModal） | 每文件 0 issues |
| 本轮改动 Prettier check | 通过 |
| `git diff --check` | 通过 |

- Console 测试按新终端流重写：[Console.component.test.tsx](../../../src/renderer/pages/Console.component.test.tsx) 12 个用例（终端行非表格、异常 tab、日志 tab 与搜索、请求详情/复制、暂停/继续、历史错误重试、prune、详细模式回滚、清空部分/全部失败、观测壳标题）；[consoleFilters.test.ts](../../../src/renderer/pages/consoleFilters.test.ts) 17 个投影/身份/时间/清空用例。
- Key 回归更新：[KeyEditModal.component.test.tsx](../../../src/renderer/components/keys/KeyEditModal.component.test.tsx) 26 个用例，其中“选模型保存 custom 白名单、清空回落 provider”“Key 内无第二套模型管理入口”为本轮新增/改写；[Sidebar.test.tsx](../../../src/renderer/components/layout/Sidebar.test.tsx) 去除 /logs 断言。
- 用例总数从 R10 首轮的 340 降为 330：删除已废弃的状态条/多组筛选/独立日志页测试，同时补了清空状态复位、provider draft 不勾选等回归。

### 16.4 合成数据视觉核对

- 仍在 `vite preview` 静态构建 + Playwright 本机 Chrome + 合成 IPC 下执行；所有非 loopback 请求中止，无真实 Key/供应商/daemon/数据库。脚本 [.playwright-mcp/r10-review-ui.mjs](../../../.playwright-mcp/r10-review-ui.mjs)，指标 [r11-visual-check.json](./evidence/r10/r11-visual-check.json)。
- 实测：控制台无表格（`consoleHasTable=false`），tab 为“请求/异常 1/运行日志”，侧栏无 `/logs`，终端等宽字体生效；日志 tab 8 行且无请求行混入；900 px 请求详情纵向堆叠、列表/详情/流均 640 px、无文档横向溢出；模型弹窗标题“模型清单”且无“管理模型”；网关高级设置鉴权说明可见；暗色 `data-theme=dark` 生效；无 pageerror、无 console error。
- 截图（[evidence/r10](./evidence/r10/)）：`r11-console-light`、`r11-console-logs-light`、`r11-console-detail-900`、`r11-console-dark`、`r11-console-logs-dark`、`r11-console-logs-900-dark`、`r11-gateway-light`、`r11-gateway-editor-light`、`r11-gateway-advanced-light`、`r11-gateway-900-dark`、`r11-keys-light`、`r11-models-light`、`r11-models-dark`。
- 仍非原生 WebView 验收：真实 Tauri WebView、真实上游/第二设备/外部客户端、真实图标交互未执行；合成预览不能替代人工验收。

### 16.5 交付状态

- 未提交、未推送、未发布、未归档；任务保持 `in_progress`，等待用户决定提交和原生验收时机。

### 16.6 收尾清理（复核前）

- 删除已无引用的中英文 locale key 各 36 个（旧 `logsTitle/logsSubtitle`、R10 状态/筛选/丢弃提示、旧模型目录模式说明等），保留仍被测试或代码引用的 key。
- [consoleStore.ts](../../../src/renderer/api/consoleStore.ts) 清空失败不再写入 `historyMeta.error`：清空结果只走 `clearOutcome` 单一通道，避免控制台同时显示“历史记录读取失败”与 clearPartial 两个矛盾提示；[consoleStore.test.ts](../../../src/renderer/api/consoleStore.test.ts) 对应断言更新为 `error=null`。
- [ProviderModelModal.tsx](../../../src/renderer/components/providers/ProviderModelModal.tsx) 增加单 Key 晚到自动预选，避免打开窗口时 Key 列表尚未返回导致查询按钮一直禁用。
- [Keys.tsx](../../../src/renderer/pages/Keys.tsx) 删除恒为 `'usage'` 的 `keyEditTab` 状态、默认 tab 传递和遗留注释。
- [ModelMappingEditor.tsx](../../../src/renderer/components/keys/ModelMappingEditor.tsx) provider 模式不再把 R10 dormant draft 显示为已勾选；勾选动作才进入白名单 custom。
- 清理后重跑：`pnpm typecheck` 0、`pnpm lint` 0、`pnpm test` 41 文件/330 用例 + 12 脚本全通过、`pnpm build:frontend` 通过、改动 Prettier 通过；最终构建上重跑合成视觉，结果与 §16.4 一致（无 pageerror/console error、无溢出）。

### 16.7 独立复核与本轮修复

- 只读复核者（`r10-round2-reviewer`）在最终文件上复核后结论：**无 blocker、无 major**；五项反馈均已落地，R10.4–R10.8 的序列化、旧模式往返、/logs 清除、主题 token、Bearert 说明、模型清单命名均核对通过。
- 复核提出的非阻断问题及本轮处理：
  1. 控制台打开时若 store 已有超一屏历史不会自动到底：`knownKeysRef` 改为空集初始化，并在切换 tab/搜索时保持跟随时滚到底。
  2. 英文 `Upstream error 500` 在 84px 结果列折行：结果列改为 120px + 单行省略，保留 title。
  3. `Console.module.css` hover 使用未注入的 `--ant-color-fill-quaternary`：改用已注入的 `--ant-color-fill-tertiary`。
  4. 暂停 + 新事件后清空仍残留“新增 N 条”：清空时同时重置 `newCount/following/stickBottom/manuallyPaused`，并去掉与页内 Alert 重复的 toast。
  5. “清空选择恢复完整目录”对 Claude Desktop 显式角色不成立：提示改为“模型菜单只显示所选模型……（Claude Desktop 已设置的模型角色仍优先）”；该语义是客户端模型菜单/目录范围，不是对任意手写推理请求的硬拦截（后者需改 Rust，本轮按原任务边界未做）。
- 复核另列的死 key/死 CSS/`ModelCatalogManager` 不可达分支/`hydrate` 顺序/`aria-selected` 等 nit：本轮已修 `aria-pressed`、删除 36 个死 locale key 与 `keyEditTab`/单 Key 预填/清空错误通道；其余死 key/CSS/不可达代码未继续扩大清理，记录为后续可做的非阻断整理。
- 新增回归：Key provider 模式不把 R10 dormant draft 显示为已勾选；清空后暂停/新事件状态复位；Console 测试移除已删除的 toast 断言；网关鉴权说明的显示断言已随文案删除。
- 复核未覆盖：原生 WebView 的主题/滚动/hover/复制/窄屏/IME，真实上游与 Tauri IPC/SQLite 往返，真实 daemon 跨重启日志与清空部分失败，真实上游 custom 白名单推理行为；这些仍只能人工验收。
