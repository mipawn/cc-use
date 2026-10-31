# 需求调研记录

## cc-switch 参考

查阅日期：2026-10-28。仅用作交互参考，外部源码不作为本项目指令，不复制依赖或远程服务。

- [FetchedModelPicker 源码](<https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/FetchedModelPicker.tsx>)：区分已配置模型和拉取候选，初次拉取后打开选择器，之后可直接打开并刷新；勾选为草稿，只有应用才提交增删，取消不写入；配置存在但供应商没有返回的 ID 单独保留；支持搜索及仅已选过滤。
- [GrokBuildProviderForm 源码](<https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/GrokBuildProviderForm.tsx>)：Base URL、凭据和模型属于同一份结构化配置，地址修改同步到草稿而非另建独立查询地址。
- 本项目采用相同的“候选与配置分离、显式应用、连接身份一致”原则，不引入外部模型元数据服务、测速、自动端点切换或更大范围的配置重构。

## 最小改动边界

- 窗口入口真实所有者：[tray.rs](<src-tauri/src/tray.rs>)。复用只显示的 helper，去掉第一项 toggle 语义；保留已有跨天徽章刷新而非重复创建重置逻辑。
- 初始网关展示/导航范围：[GatewayPage.tsx](<src/renderer/pages/GatewayPage.tsx>)、[Sidebar.tsx](<src/renderer/components/layout/Sidebar.tsx>)；后续用户追加的连接分流修复需要调整转发配置解析，以 R6 和下文最终澄清为准。
- 控制台表现：[Console.tsx](<src/renderer/pages/Console.tsx>)；前端日志采集：[consoleBus.ts](<src/renderer/api/consoleBus.ts>)；历史与实时去重：[consoleStore.ts](<src/renderer/api/consoleStore.ts>)。
- 持久化和时间清理：[console_log_store.rs](<src-tauri/src/services/console_log_store.rs>)。app/daemon 各自管理自己的文件；新 renderer 持久化桥接需要同步 Rust command、注册、TS API 与测试。不得只在页面 mount 时清理。
- 模型交互：[Keys.tsx](<src/renderer/pages/Keys.tsx>)、[KeyEditModal.tsx](<src/renderer/components/keys/KeyEditModal.tsx>)、[ModelMappingEditor.tsx](<src/renderer/components/keys/ModelMappingEditor.tsx>)、[ModelCatalogManager.tsx](<src/renderer/components/keys/ModelCatalogManager.tsx>)。优先复用已有 modelCatalogPreview 草稿接口与 clientConfigs 的地址覆盖。
- 通用支持仅涉及必要的样式、中英文案、API/类型镜像和回归测试，不扩展到整个应用重构。

## 现有约束与风险

- 用户已确认方案 A：三天为最长留存，同时保留容量保护；超限可提前淘汰并明确提示截断，不能把“三天”写成完整归档保证。
- renderer 原 ID 仅页面内递增；落盘前需要跨刷新唯一的身份，历史回放与实时事件采用相同去重键。
- app/daemon 写入各自文件；现有总预算清理会跨来源淘汰旧文件并保护每个来源的最新文件，新增按日维护不能误删活动文件。当前工作线程使用阻塞 recv，没有空闲计时维护，必须补上空闲跨天与启动补扫。证据：[console_log_store.rs:262–295](<src-tauri/src/services/console_log_store.rs#L262-L295>)、[console_log_store.rs:539–563](<src-tauri/src/services/console_log_store.rs#L539-L563>)。
- “不影响历史统计”是指不改变现有策略，并不承诺永久累计：应用启动会清理 90 天前的请求和启动用量记录；徽章当天用量与密钥总量均由当前保留的 request_logs 聚合。证据：[lib.rs:327–332](<src-tauri/src/lib.rs#L327-L332>)、[request_logs.rs:679–738](<src-tauri/src/db/request_logs.rs#L679-L738>)。
- 不得把前端 console.error 的持久化失败再 console.error 回相同通道；内容需要在后端信任边界再次校验与脱敏。
- Base URL 变动要同时失效目录缓存和在途请求，但不能无提示丢弃已保存模型或未保存表单。
- “跟随供应商目录/仅选定模型”是目录策略，不等于“云端拉取/手动新增”两个动作；UX 收敛不能隐式改写旧配置含义。

## 后续验证重点

1. 窗口多状态手工验收与入口语义回归。
2. 请求异常筛选、历史恢复、行详情和日志等级/来源筛选的组件测试。
3. 三天边界、启动/空闲清理、日切文件、容量策略、秘密脱敏、持久化失败和并发清理的 Rust 测试。
4. 模型获取不自动保存、刷新保留自定义、手动去重、错误重试、URL 草稿、跨 key/URL 延迟响应的组件及服务测试。
5. 集成后运行 pnpm typecheck、pnpm lint、pnpm test、cargo fmt --all -- --check、cargo test --workspace；按受影响模块补充 clippy。

## 新增问题：模型查询有结果，密钥选择无结果

### 已证实的入口差异

1. 两条路径的底层 HTTP 和模型目录解析其实已经共用 fetch_provider_model_catalog，不能把它误诊为两个独立 parser。[providers.rs:292–425](<src-tauri/src/commands/providers.rs#L292-L425>)、[model_catalog.rs:162–194](<src-tauri/src/services/model_catalog.rs#L162-L194>)。
2. 供应商 viewer 对多客户端 Key 默认优先 codex，再 grok，再第一个类型；编辑器始终使用当前展开的客户端类型。因此同一 Key 可能用不同的 Base URL、authScheme 和按 provider/client 存储的查询 UA。[modelQueryUserAgent.ts:8–36](<src/renderer/utils/modelQueryUserAgent.ts#L8-L36>)、[Keys.tsx:494–509](<src/renderer/pages/Keys.tsx#L494-L509>)、[ModelMappingEditor.tsx:243–282](<src/renderer/components/keys/ModelMappingEditor.tsx#L243-L282>)。
3. viewer 使用已保存的 Key 配置并把结果存在自身 modelList state，关闭就清空；模型编辑使用独立 catalogs state 和当前未保存的 Key/clientConfigs 草稿，preview 不持久化目录缓存。不存在“查看成功后自动共享给密钥选择器”的数据流。[Keys.tsx:1272–1293](<src/renderer/pages/Keys.tsx#L1272-L1293>)、[ModelMappingEditor.tsx:118–133](<src/renderer/components/keys/ModelMappingEditor.tsx#L118-L133>)、[model_catalog.rs:65–74](<src-tauri/src/services/model_catalog.rs#L65-L74>)。
4. UA 改变后 viewer 的 onApply 会重新查询；编辑器的 changeAgent 使旧目录 identity 失效，applyAgent 却只记住偏好，不重新读取模型。输入失焦、Enter 和选择预设都会触发 onApply，因此两个入口相同动作的效果不同。[Keys.tsx:1324–1335](<src/renderer/pages/Keys.tsx#L1324-L1335>)、[ModelMappingEditor.tsx:219–240](<src/renderer/components/keys/ModelMappingEditor.tsx#L219-L240>)、[UserAgentField.tsx:74–102](<src/renderer/components/UserAgentField.tsx#L74-L102>)。
5. custom 目录模式的普通模型下拉只消费已应用的 client.models，而不是未勾选的云端候选。这种“候选不自动成为配置”的安全语义应保留，但选择器必须明确展示候选/已选区别，不能让正常的未应用状态看起来像拉取失败。[ModelMappingEditor.tsx:326–341](<src/renderer/components/keys/ModelMappingEditor.tsx#L326-L341>)。

以上是源码证实的确定差异；未读取用户真实凭据或调用用户上游，尚不能断言当前现场只由其中某一项造成。

### 拟定最小修复边界

- 统一入口组件、显式查询上下文及结果状态；同一供应商/Key/客户端/有效地址/认证/UA 使用相同候选列表，仍复用现有底层 fetch，不增加第二个网络实现。
- 在统一入口显示客户端与有效查询地址，避免自动挑选另一客户端而界面没有提示。不同客户端如需使用同一发现来源，须显式选择，不能静默 fallback 并覆盖真实转发配置。
- 新增/编辑使用草稿查询，但获取模型不会保存密钥或模型配置；候选结果和勾选草稿分开。
- UA/URL 应用与刷新行为一致：使用新值查询并正确显示 loading/error；身份变更后丢弃旧响应，而不是清空后无反馈。
- 回归覆盖：多客户端不同 URL/auth/UA、两入口相同 identity、查看后进入模型选择、UA Apply、草稿地址、未应用模型、延迟响应。
- 当前组件测试只覆盖目录勾选等局部行为；[Keys.query.test.tsx](<src/renderer/pages/Keys.query.test.tsx>) 模拟的是用量查询，不覆盖模型链路；[ModelCatalogManager.component.test.tsx](<src/renderer/components/keys/ModelCatalogManager.component.test.tsx>) 不覆盖两入口和 UA 异步链路。实施时补齐，不声称本轮已修复或已复现真实上游。
- 2026-10-28 基线验证：运行上述两文件及 [KeyEditModal.component.test.tsx](<src/renderer/components/keys/KeyEditModal.component.test.tsx>)，3 个测试文件、19 个测试通过，退出码 0；jsdom 输出已有的 getComputedStyle pseudo-element 未实现警告。此结果只证明现有局部回归通过，不覆盖用户报告的新问题。

## 新增问题：网关绑定与转发配置

### 当前继承矩阵（Lead 已复核源码）

- 网关是持久的本地 session token，只绑定一个 providerId/apiKeyId；现有 DTO/创建命令不存独立 UA、Header、模型规则或客户端配置来源。[models/mod.rs:328–341](<src-tauri/src/models/mod.rs#L328-L341>)、[gateways.rs:34–66](<src-tauri/src/commands/gateways.rs#L34-L66>)。
- 推理请求的 gateway 被标为 transparent 并强制 cli_type=None；session_client_config_key(None) 又默认为 claude_code。因此 Base URL、authScheme 和 proxyUserAgent 读取的是 key.clientConfigs.claude_code，缺少 Base URL 才回退供应商地址。[handler.rs:1277–1368](<src-tauri/src/proxy/handler.rs#L1277-L1368>)、[handler.rs:1602–1608](<src-tauri/src/proxy/handler.rs#L1602-L1608>)。
- **明确缺陷：网关 /models 与实际推理的配置来源不一致。** /models 按 codex → grok → Key 首类型 → claude_code 选择查询配置，而实际推理固定落到 Claude Code 连接配置。多客户端/非 Claude Key 因而可以查模走 A 地址、实际请求走 B 地址。[handler.rs:396–426](<src-tauri/src/proxy/handler.rs#L396-L426>)。
- HTTP UA：Key 的 Claude Code proxyUserAgent 优先，其未设置时回退同 provider/claude_code 的查询 UA；有效的 chosen UA 最后覆盖客户端原 UA。没有有效 chosen UA 则保持原值（供应商 additive 默认可补缺）。模型查询单独读取 catalog_kind 下的查询 UA，并由查询函数决定默认 UA。[handler.rs:1328–1346](<src-tauri/src/proxy/handler.rs#L1328-L1346>)、[handler.rs:708–711](<src-tauri/src/proxy/handler.rs#L708-L711>)、[handler.rs:2095–2110](<src-tauri/src/proxy/handler.rs#L2095-L2110>)。
- HTTP Headers：供应商 requestHeaders 会补充客户端没有的同名头，不覆盖客户端已有值；Key/Gateway 当前没有单独自定义 Header 字段。Authorization/x-api-key 先由绑定 Key 与 authScheme 替换，不使用本地 session token 直发上游。[handler.rs:658–669](<src-tauri/src/proxy/handler.rs#L658-L669>)、[handler.rs:2041–2092](<src-tauri/src/proxy/handler.rs#L2041-L2092>)、[handler.rs:2113–2149](<src-tauri/src/proxy/handler.rs#L2113-L2149>)。
- 模型映射：虽然路由加载了 Key 的 model_mapping，apply_model_mapping 遇到 transparent 立即返回原 Body，别名解码也不执行。是上一版“网关透明转发”的刻意行为，不是保存丢失。[handler.rs:1764–1795](<src-tauri/src/proxy/handler.rs#L1764-L1795>)。
- WebSocket 握手复用认证和 chosen UA，但没有调用 HTTP 的 apply_provider_headers，现有 Header 行为并不完全一致。新增覆盖能力必须明确并测试 HTTP/WS 一致性，不只是改普通 POST。[handler.rs:2887–2908](<src-tauri/src/proxy/handler.rs#L2887-L2908>)。

### 用户最终澄清（2026-10-28，取代先前备选）

- 用户同意统一模型查询与密钥选择；网关典型客户端为 DeepSeek Harness 桌面端。
- 未采用此前“继承 Key 某个启动台配置 + 独立模型覆盖”的建议：网关面向外部客户端，绑定 Key 只提供凭据，不与 Claude Code/Codex/Grok/Claude Desktop 配置耦合。
- 网关直接编辑 Base URL、认证、User-Agent；其他使用供应商设置。Header 仍在供应商配置，本轮不新增网关 Header 编辑器。
- 网关仅获取并暴露上游模型，由外部客户端自行选择，不增加模型白名单、默认模型、映射、角色或启动参数。
- 模型发现与实际转发使用同一个网关连接策略；升级保留本地 Key 和绑定，不启用旧 Key 上的模型映射。
- 非目标仍为协议转换、Key 故障转移和模型路由平台。

### 调研交接

网关只读 teammate 提供了关键配置来源不一致的证据；为控制调研耗时，Lead 停止其后续探索并接管剩余 UA/Header/映射复核。无产品文件写入，结论以上述实际读取的源码为准。

## 原始 DSH 会话核对（2026-10-28）

本次续接补读了标题为“网关、控制台与密钥优化”的原始 DSH 会话，而非仅依赖任务文档或另一段 Codex 排障摘要。

- 会话 ID：`session-b482c077-284e-45f2-aaad-15747964a202`。
- 原始文件：`/Users/dongzhan/.dsh/sessions/--Users-dongzhan-Desktop-mipawn-cc-use--/session-b482c077-284e-45f2-aaad-15747964a202/session.v4.jsonl.zstd`；只读解压核对，未改动原会话。
- seq 17 的最初五项需求已分别落入 R1（固定打开主界面）、R2（网关精简）、R3（控制台合并/筛选与三天文件日志）、R4（统一模型管理及 Base URL）和 R5（独立导航）。
- seq 420 明确选择日志方案 A，并追加“查模有结果但密钥选择无结果”及网关配置关联问题，已落入 R3/R4/R6。
- seq 761 同意模型入口统一，同时明确网关面向 DeepSeek Harness 桌面等外部客户端，只暴露模型供客户端自行选择，连接配置直接展示，其余使用供应商设置；已落入 R6。
- seq 753 中“继承内置客户端配置并允许 Header/模型覆盖”只是助手备选，已被 seq 761 的用户澄清取代，不应恢复进实施范围。
- seq 787/960 表明当时仍在收敛最终方案；最后三轮（seq 981/989/1002）以跨 Azure 资源 400 结束，未出现完整最终摘要之后的明确实施批准。多次“继续”不能被记为已完成编码或验收。
- 对照现有 prd.md、design.md、implement.md、research.md，未发现用户已明确提出而规划遗漏的产品要求。本次仅补记核对来源，不扩大任务范围；另一段 Codex 会话中关于 Azure 400/TPM 的排障和兼容建议不属于本 DSH 会话已确认需求。

## 设计细化的源码核对（2026-10-28）

- `models/mod.rs::ProxySession/Gateway` 和 `db/proxy_sessions.rs::GATEWAY_SELECT/row_to_proxy_session/gateway_update` 当前均无独立连接字段，因此 design.md 明确新增列、双 DTO 镜像与整体替换更新语义。
- `commands/providers.rs::fetch_provider_model_catalog` 当前包含网络/分页实现，`services/model_catalog.rs` 反向调用命令；本次设计要求把通用获取实现下沉服务，不复制第二套解析器。旧实现将有效空目录当作错误，实施需区分空结果与失败。
- `proxy/handler.rs::ensure_v1_path/build_provider_upstream_url` 可复用路径规则；`apply_provider_headers` 当前按 provider.base_url 替换模板，`build_upstream_ws_request` 未应用供应商普通头。新网关统一有效地址模板与 HTTP/WS/模型获取的受保护头策略，内置客户端不做无关重构。
- `console_log_store.rs::ConsoleLogRecord.at`、`proxy/console.rs::now_timestamp` 和 `consoleBus.ts::nowTimestamp` 均按 UTC 保存无后缀时间字符串；本地三天边界必须显式做 UTC→本地转换。
- `console_log_store.rs::write_meta/clear_source/rotate` 当前共享固定 meta.json.tmp，writer 使用阻塞 recv、启动可能续写旧活动文件；设计补充维护锁、唯一临时文件、启动新 active 和空闲/持续流量检查，不能仅加一个日期判断。
- `commands/console.rs::console_log_status` 当前只返回 app dropped，clear 在任一来源成功时就返回成功；新增持久化桥需可见地表达来源离线、失败与部分清空，避免将入队确认当成落盘确认。
- `services/app_logger.rs::install` 和 daemon `console_logger.rs::install` 保持 Info 上限及自有 target 过滤；renderer 的 debug 持久化不能成为全局打开 Rust 依赖库 debug/trace 的理由。

以上为源码只读核对；本轮更新设计/实施文档及上下文清单，未运行产品测试，也未验证新实现行为。

## 新增问题：网关请求未显示在供应商线路质量（2026-10-28）

### 已确认的统计链路

1. `ResourceUsageModal.tsx` 的“线路质量”使用 `requestLog.getResourceStatistics(timeRange, providerId, apiKeyId?)`，后端经 `commands/statistics.rs::request_log_get_resource_statistics` 到 `db/request_logs.rs::request_log_get_resource_statistics`。按稳定 provider_id/api_key_id 筛选 request_logs，没有按 gateway/cli_type/project 过滤网关的条件。
2. `proxy/handler.rs::build_route_execution` 为 gateway 同样填入 ResolvedSessionContext；HTTP 的 base_log_ctx 再携带 provider_id/api_key_id/request_id。非流式成功带 usage 与失败会写记录；SSE 由 UsageTrackingStream 终结后写入。不能从 transparent 或 cli_type=None 推断所有网关都跳过统计。
3. 另一套 `gateway_request_events` 由 `ProxyState::emit_console` 异步记录，供应商卡片近 24 小时成功率从 `db/gateway_metrics.rs::gateway_metrics_by_provider` 读取并按名称关联。它不是详情“线路质量”的数据源；本次不能将两套数量直接相加。

### 确定的界面缺口

- `ResourceUsageModal.tsx` 的查询 effect 仅依赖 open/scope/timeRange，没有定时重查，也没有 usePageRefresh 注册。弹窗保持打开期间，后续请求不触发该 effect。
- `Keys.tsx` 已注册的 usePageRefresh 只调用 fetchProviders/fetchProviderMetrics；这会刷新供应商卡片指标，却不会重新查询打开的线路质量弹窗。
- 弹窗查询 catch 只 console.error，并将 stats 保持 null，最终呈现与无记录相同的 Empty；界面无法区分失败和真实无数据。

### 本机只读现场证据

仅以 SQLite `mode=ro` + query_only 查询聚合数量，未读取 Key.value/凭据、原始 Body/Header，也未调用上游、管理接口或修改数据库。读取时生产库有 **222 条**关联 gateway session 的 request_logs，其中成功 **108 条**；这些 gateway 行的 provider_id/api_key_id 均非空。

读取时近 24 小时 console 指标可关联到 gateway request_logs 的记录为 ok 108 条、upstream_error 34 条；唯一未关联到 request_logs 的成功指标是 GET models，符合成功非推理不写计费请求的既有规则。未发现近 24 小时 provider_name 无法匹配现存供应商的记录。数量是当时快照，不代表之后实时值，也不能证明每个现场请求均已记录。

### 结论与实施约束

- 已证实刷新和错误态缺口；目前不支持“所有网关请求都未落库”的判断。是否还有某种返回形状/失败阶段漏记，需 T21 端到端用例捕获后判断，不提前指定不存在的排除条件为根因。
- 保留两个统计来源和现有 outcome/usage 口径；不新增第二套质量表，不补造 usage，不从旧名称推测历史 provider_id。
- HTTP 成功但无 usage 目前会跳过 request_logs；WS 在 HTTP base_log_ctx 创建前走独立分支，目前只有连接/console 指标，不能声称握手即有请求级质量/用量。新增验收覆盖这些边界，但不顺势新增通用 WS 推理帧解析或计费体系。
- 新增需求/验收为 R7、A16/A17；设计补统计链路与刷新策略，实施补 Q-STATS/T21/T22。仍为 planning，本轮未改产品代码、未执行新测试。

### 进一步核对：首次打开 anyRouter 趋势为空的现场原因

用户随后澄清：供应商为 **anyRouter**，第一次点击趋势就显示“当前范围暂无代理请求数据”，不是弹窗保持打开后未刷新。前一轮把刷新缺口作为主要解释的方向不适用于这一现场。

- 在已安装的 CC Use 3.15.0 中直接操作当前 anyRouter 菜单复现：默认近一周显示暂无代理请求数据；切到近一月正常返回 **29 条请求、156 Token**，趋势有历史日期 10/6、10/17。证明该入口能成功查到此供应商的历史数据。界面核对仅切换弹窗时间范围，未改保存的配置。
- 对生产库只读按现存 providerId 精确聚合：anyRouter 最近一条请求日期为 2026-10-17，近一周为 0；agentRouter 有近期网关请求。之前“全体 gateway 有 222 条”的快照不能证明 anyRouter 有近期记录。
- anyRouter 网关的 last_seen_at 等于创建时间，按其 session_id 关联 request_logs 为 0；agentRouter 网关有近期活动和已归属请求。未发现这些已记录请求的 providerId/keyId 相互错配。
- 仅在本机内存中读取 DSH `cordis.patch.yml` 的 apiKeyEnv 引用，并与 `.credentials.yaml` 引用值及只读 proxy_sessions 做相等匹配；不输出 token/密钥值。结果：**DSH any-router 和 agent-router 使用的本地 session token 都解析为 cc-use 的 agentRouter gateway**，不是 anyRouter gateway。
- 因此该现场是外部客户端配置名称与实际网关绑定不一致：统计按真实绑定进入 agentRouter，anyRouter 默认范围为空符合数据。修正接入需让 DSH any-router 使用 anyRouter 网关对应的本地 Key；这会改变实际上游，本次未自动修改凭据或绑定。
- 本地 Recharts 源码还确认单数据点即使 dot=false 也会绘制点，不能仅看到 dot=false 就诊断为空白根因；用户明确的 Empty 状态也不属于图表曲线渲染问题。

规划保留 R7 的归属/首次查询回归和独立刷新/错误态改进；不再把当前 anyRouter 空结果标为已证明的写入或刷新故障，不补造历史记录，也不扩大为 DSH 自动配置任务。

## 2026-10-29 五项交互返工调研

本节为工作区静态检查与 HEAD diff 对比，不代表已在实际 WebView 中完成视觉复现；本轮未改产品代码、未运行测试或启动服务。

1. 菜单间距来自 [WorkspaceLayout.module.css:43–66](<src/renderer/components/layout/WorkspaceLayout.module.css#L43-L66>)：`standalone` 和 `observationGroup` 各自 margin-top 25px；[Sidebar.tsx:46–58](<src/renderer/components/layout/Sidebar.tsx#L46-L58>) 将网关放在独立 wrapper 中。折叠/窄窗口还叠加 margin/padding/border，需一起收紧。
2. [ModelCatalogManager.tsx:99–104](<src/renderer/components/keys/ModelCatalogManager.tsx#L99-L104>) 沿用目录策略作为列表编辑模式；[勾选呈现:337–353](<src/renderer/components/keys/ModelCatalogManager.tsx#L337-L353>) 仅 custom 可勾选。映射候选来源在 [ModelMappingEditor.tsx:255–267](<src/renderer/components/keys/ModelMappingEditor.tsx#L255-L267>)，但 [固定/家族/分类模型:680–760](<src/renderer/components/keys/ModelMappingEditor.tsx#L680-L760>) 仍是普通 Input。应修正这条真实数据流，不能只换提示文字或再写模型解析器。
3. [GatewayPage.tsx:45](<src/renderer/pages/GatewayPage.tsx#L45>) 新建默认 Bearer；[认证选项:783–798](<src/renderer/pages/GatewayPage.tsx#L783-L798>) 无“默认”展示；[模型区:823–942](<src/renderer/pages/GatewayPage.tsx#L823-L942>) 是搜索/复制的只读预览，没有模型保存字段。因此问题是表单信息层级误导，而非网关实际要求模型才能保存。Key 编辑器的“默认”按 clientKind 选择认证，与独立网关不是同一个默认，不能照搬 [KeyEditModal.tsx:612–631](<src/renderer/components/keys/KeyEditModal.tsx#L612-L631>)。
4. [Console.tsx:1084–1138](<src/renderer/pages/Console.tsx#L1084-L1138>)、[RequestRow:1197–1285](<src/renderer/pages/Console.tsx#L1197-L1285>) 用终端 flex 行伪装列而非 Table；[ActivityPage.tsx:13–28](<src/renderer/pages/ActivityPage.tsx#L13-L28>) 仍有统计/控制台 Tabs。HEAD 对比显示本轮只改了 Sidebar，ActivityPage/统计页/路由仍维持旧结构，造成重复导航；没有独立日志路由。拆分保持 /stats、/console 兼容即可，不需要重写日志落盘或统计后端。
5. 自定义上传图标位于 [ProviderModal.tsx:300–356](<src/renderer/components/providers/ProviderModal.tsx#L300-L356>)；[Api.icon:263–267](<src/renderer/api/types.ts#L263-L267>) 只有 read/upload/list；[system.rs](<src-tauri/src/commands/system.rs>) 没有删除命令。删除需限制在应用上传图标目录内的普通文件，拒绝路径穿越/符号链接，不删除内置图标；同时处理 [ProviderIcon.tsx:7–48](<src/renderer/components/providers/ProviderIcon.tsx#L7-L48>) 的共享读缓存和正在使用的引用。
6. 环境核对：antd 6.2.3、React 18.3.1；`antd doctor --format json` 12 pass / 0 warn / 0 fail。没有证据表明这些交互缺口由组件库安装或主题配置导致。

边界：沿用现有任务和所有未提交改动；本轮以交互和必要的图标删除接口为主，不改真实生产数据、不发布/重启用户服务、不改 DSH。用户已选择“按这个方式简化”：新建仍默认 Bearer，x-api-key/不鉴权放高级设置，已有显式配置不变；不增加自动认证判断。

### 控制台只读复核补充与最终收敛

- 子代理已完成源码/样式/测试及 HEAD 对比，无文件修改、测试或服务。统计页与原 ActivityPage/App/TitleBar 在检查时相对 HEAD 无差异；不能声称这些已完成重构。
- HEAD 日志正文原为直接 pre-wrap，当前为单行加右侧全文详情。最新范围只要求请求真 Table，规划保留当前日志全文/复制体验，不再顺手更换日志渲染。
- [Console.tsx:560–565](<src/renderer/pages/Console.tsx#L560-L565>) 的筛选是局部状态；原两个 view 共享 query，不跨路由持久化。本轮三页在观测壳内保留各自会话筛选，不新增 localStorage；[页面刷新注册](<src/renderer/pages/Console.tsx#L737>) 需随当前页正确装卸。
- [consoleStore.ts:281–317](<src/renderer/api/consoleStore.ts#L281-L317>) 清空全部请求与日志，不是单页或筛选结果。新确认文案必须明确全局范围，继续展示部分来源失败；统计/Auto 审计不受影响。
- [main.tsx:19–29](<src/renderer/main.tsx#L19-L29>) 全局采集与 store 不依赖页面 mount；[生命周期合并](<src/renderer/api/consoleStore.ts#L125-L164>)、日志去重、已捕获详情、三日/500 条/8 MiB 有界窗口需保持，不复制持久化管线。
- [Console.component.test.tsx:303–388](<src/renderer/pages/Console.component.test.tsx#L303-L388>) 原断言两个 Segmented 并未证明真实 Table；需换成 table/th/td、稳定行身份、路由与键盘详情断言。日志过滤/复制测试迁移而非删除，保留筛选、状态、历史失败重试、部分清空失败和跟随/暂停回归。
- 本轮最终设计选择单层三入口、无实时请求分页、保留当前时间顺序/尾部跟随/详情面板，统计账本不变；前端静态检查不能代替后续明暗主题/折叠/窄屏视觉核对。

## 2026-10-29 模型职责修正与三项确认

本节取代前节中仅调整模型入口外观、网关可留预览以及只需图标后端变更的范围判断。用户明确纠正：获取模型必须选择 Key、Base URL、UA，并且只有一个地方；模型映射不应再获取，网关不需要查看模型，但要选择暴露模型和连接设置。没有因此获准实施，以下仍是静态调研/规划，不是完成报告。

### 用户决策

1. 选择“展示与调用都受限”：缺省全部可用；配置指定集合后，模型列表只显示已选模型，手工请求未选模型也必须拒绝。
2. 选择“改造外层查看模型”：供应商/密钥列表外层打开独立管理窗口，里面选 Key/Base URL/UA，映射和网关读取该处管理的模型；不新增单独模型页面，不再跳进 Key 编辑。
3. 选择“无法验证就拒绝”：指定模式不能因协议不透明而绕过限制；默认全部模式保留既有透传。无需为本轮补齐通用 WS/二进制协议识别，严格模式先拒绝不能验证的请求。
4. 原确认保留：新网关 Bearer 默认，特殊认证放高级设置，既有显式覆盖不变。

### 已检查的技术事实与设计影响

- 外层“查看模型”目前通过 [Keys.tsx:461–473](<src/renderer/pages/Keys.tsx#L461-L473>) 设置 modelMapping tab 并打开 Key 编辑；[入口菜单:709–728](<src/renderer/pages/Keys.tsx#L709-L728>) 按 Key 建子菜单。只共享组件仍然在错误的位置，需要改为独立窗口、把 Key 选择放在窗口内。
- [useModelCatalogQuery.ts:47–56](<src/renderer/hooks/useModelCatalogQuery.ts#L47-L56>) 仍强制 clientKind/clientConfigs；[身份与缓存:95–166](<src/renderer/hooks/useModelCatalogQuery.ts#L95-L166>) 为 32 项/5 分钟进程缓存，不是跨重启模型清单。独立获取必须使用显式连接草稿；供应商管理清单须单独持久化，映射/网关订阅读取，不能仅依靠缓存共享。
- [model_catalog.rs:78–106](<src-tauri/src/services/model_catalog.rs#L78-L106>) 的后台缓存身份也是 Key/客户端/路由上下文；[effective_catalog:278–307](<src-tauri/src/services/model_catalog.rs#L278-L307>) 服务内置客户端目录与角色。新管理清单不能替换这些 provider/append/custom 运行时语义。
- [模型获取服务](<src-tauri/src/services/model_catalog.rs#L109-L162>) 已有查询/分页/快照转换，网关有效连接的 [resolve](<src-tauri/src/shared_runtime/gateway_connection.rs#L111-L139>) 不依赖某个客户端。独立查询复用服务与连接/头校验，不复制解析器，不为查询创建网关，更不改 Key 的转发字段。
- [Gateway 类型:811–832](<src/shared/types/index.ts#L811-L832>) 目前只有 connectionConfig，没有暴露策略。需要增量持久化与 DTO/IPC/代理读取成套接通，不能只增加前端勾选。旧 SQL NULL 缺省全部，坏数据报错而非解除限制。
- 当前 [gateway 模型发现:419–467](<src-tauri/src/proxy/handler.rs#L419-L467>) 调上游目录；[HTTP body:705–726](<src-tauri/src/proxy/handler.rs#L705-L726>) 才读取 model；[WS 升级:541–638](<src-tauri/src/proxy/handler.rs#L541-L638>) 更早建立上游连接，随后 [文本/二进制:3156–3173](<src-tauri/src/proxy/handler.rs#L3156-L3173>) 直接透传。因此 HTTP body 的单点检查不能保护 WS，也不能证明其他路径安全。
- 最小安全边界：指定模式发布显式 model ID 集合；对已知 JSON 推理路径精确校验，无法判断则拒绝，原样 WS 先在连接上游前拒绝。全部模式不改。验收需要“不允许的请求上游零命中”，不是只检查下拉项或错误文案。
- 只读网关子代理未完成且无结果；本节结论来自 Lead 逐段读取，不把委派当成完成证据。仍未改产品代码、运行产品测试、启动或重启服务。

### 本轮规划校验

- PRD 已做完整重写收敛并从头到尾复读；保留 R1–R9、R9.1–R9.5 与 A1–A25 映射，已回答问题不再列为待确认。原锚点及不冲突约束保留。
- 文档检查实际通过（exit 0）：四份 Markdown 无行尾空白，145 处本地引用的目标存在；两个 JSONL 各 20 条真实 spec/research 记录，均非占位且文件存在。任务目录当前未跟踪，不能把空的 Git diff 当成文档已审查证据。
- 核对 [package.json:6–28](<package.json#L6-L28>) 和 [build-frontend.mjs](<scripts/build-frontend.mjs>)：前端构建应使用 `pnpm build:frontend`，`pnpm build` 是 Tauri 打包。新执行计划不把打包/安装/重启当默认检查。
- 尚未运行产品测试或实际 WebView 验收；最终摘要仍待用户随后明确批准后才能开始实施。



