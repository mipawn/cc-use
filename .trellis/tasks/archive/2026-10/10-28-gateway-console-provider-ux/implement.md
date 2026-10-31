# 实施计划与验证

## 1. 当前门禁与完成定义

需求见 [prd.md](<.trellis/tasks/10-28-gateway-console-provider-ux/prd.md>)，设计见 [design.md](<.trellis/tasks/10-28-gateway-console-provider-ux/design.md>)，证据见 [research.md](<.trellis/tasks/10-28-gateway-console-provider-ux/research.md>)。上一轮实现已在工作区，任务记录为 `in_progress`。2026-10-29 最新三项确认已纳入第 11 节：外层唯一模型管理、展示和调用双重限制、无法验证即拒绝；默认 Bearer 的原确认保留。2026-10-30 用户已明确批准按最新计划实施，现已恢复现有任务指针并进入第 11 节；不新建重复任务。

第 2–10 节保留为上一轮工作包、测试编号和证据线索，不是本轮开工清单。其双获取入口、网关模型预览及禁止暴露选择的旧断言已被 R4/R6/T28/T29 替代，不能按旧 UI 断言实现或验收。其余 T01–T26 继续作为必要回归，实际执行结果需重新记录。

实施完成必须将 A1–A25 对应到自动测试或手工记录，区分本轮 A21–A25 的新证据、既有回归、失败和未执行。不把既有 19 个测试基线或旧验证报告当作新需求验收。不自动提交、推送、发布、安装、重启生产 daemon 或修改 DSH 配置。

## 2. 分阶段执行与责任边界

按依赖推进；每阶段通过针对性验证后再进入后续阶段。Codex auto 模式由 Lead 协调 Trellis implement/check 子代理；派发前设置当前任务、明确 write_scopes、加载对应 jsonl，避免子代理再次规划或创建任务。共享 API/类型、注册、中英文案和集成文件由一个写入者串行维护。

### P0：契约与可复现缺陷

- [ ] 读取本任务 jsonl 中对应 spec；UI 实施时加载 antd skill，查本地版本与相关组件元数据。
- [ ] 在本地 mock 中复现多客户端 Key 的 gateway /models 与推理配置分流；记录真实收到的 URL/auth/UA/model。
- [ ] 补模型入口相同身份、UA Apply 后重查、旧响应晚到的针对性用例；排除“未应用候选”被误当拉取失败。
- [ ] 新增供应商线路质量 T21/T22 基线：保护 token 真实归属及首次点击的 providerId；当前 anyRouter 空结果已定位为 DSH 实际接入 agentRouter，不以强制写错供应商作为修复。单独复现页面刷新未重查及失败误显示无数据，不预设所有网关请求未入库。
- [ ] 在文档中冻结 GatewayConnectionConfig、可选整体替换更新语义、gateway 模型预览、renderer 批次及历史/状态扩展 DTO；本阶段不提前添加尚未接通的产品字段或命令。
- [ ] 搜索全部类型构造点、命令调用方和 model catalog 服务反向引用，列入 P1/P3 原子改动清单；不在基线阶段移动产品网络实现。

写入范围：本地 mock/测试 fixture、可运行的回归测试及证据记录。门禁：先证明失败来自旧行为而非 fixture/编译错误；新行为测试在旧代码上可暂时为红，但必须记录预期失败断言，不能跳过用例或把该状态标成质量检查通过。P1/P2 修复后这些用例全部转绿。

### P1：外部网关后端（依赖 P0）

- [ ] 按原子单元 G-API 为 proxy_sessions 加 CREATE/ALTER 新列，更新所有 mapper/SELECT/INSERT/UPDATE、Rust/TS 模型、API/命令注册及受影响 fixture。
- [ ] 将通用模型网络实现下沉 Tauri-free service，旧入口保留兼容 wrapper；用回归证明移动本身不改变客户端目录/认证语义。
- [ ] 完成 marker 事务迁移：只为旧 gateway NULL 列提取显式 Claude Code 连接值；不读查询偏好，不复制映射；新列已有值不覆盖。
- [ ] 用旧行、新行、已有配置、迁移重跑及失败回滚证明 token/名称/绑定/启停和 Key/provider 均保留；历史非法 URL/UA 可见可修复，不阻止全库升级。
- [ ] 接入统一网关有效连接和 URL 路径构造；/models、/v1/models、预览、HTTP/SSE、WS 使用一致来源。
- [ ] 统一网关 Header 策略及有效 Base URL 模板替换；保护认证、Host、逐跳与 WS 握手字段，none 不泄漏本地 token。
- [ ] 测试绑定/供应商不匹配、禁用/耗尽 Key、禁用 gateway、无效地址/UA、空目录、分页和目录限制。
- [ ] 确认非 gateway 不进入新解析分支，model/body、内置客户端路由、目录角色和映射不变。

写入范围：db、models、shared_runtime、commands/gateways、model_catalog、proxy/handler 及相关测试。门禁：mock 上游捕获通过，迁移幂等；没有真实 Key 或生产 daemon 操作。

### P2：网关界面与模型入口（依赖 P1）

- [ ] 网关编辑显示 Base URL/来源、认证、UA；恢复默认发送完整 connectionConfig 对象中的 null，绑定变更保留网关覆盖。
- [ ] 添加只读模型预览区（搜索、复制、刷新、状态）；不增加默认模型、勾选、映射、角色或启动参数；移除卡片两段长说明。
- [ ] 供应商入口接入统一管理流程，显式 Key/客户端；移除 Keys 页独立 modelList 查询/state 链路。
- [ ] 提取统一查询控制器，落实身份、revision、候选缓存上限和旧响应隔离；草稿查询不落盘，不按 providerId 单独缓存。
- [ ] Base URL 与 Key 连接页共用草稿；查询 UA Apply 直接使用当前值重查，不写代理 UA 或自动记住偏好。
- [ ] 将云端获取/手动添加变为同一列表动作，目录策略保留 provider/append/custom；候选、勾选、手动模型、外层配置各自拥有明确状态。
- [ ] 子视图应用只更新外层草稿；外层保存才写 Key。取消、刷新、空结果、失败均不丢已保存/手动模型。
- [ ] 补多 Key/客户端、不同 URL/auth/UA、A/B 延迟结果、字段恢复、候选不自动保存、策略及旧字段往返用例。

写入范围：GatewayPage、Keys、KeyEditModal、ModelMappingEditor、ModelCatalogManager、必要共享 hook/list、样式及组件测试。共享 API/locale 由 Lead 或指定单一写入者集成。门禁：两入口相同有效身份得到一致候选，原有客户端语义回归通过。

### P2b：供应商线路质量（依赖 P1；与 P2 的 Keys/usage 修改串行）

- [ ] 用本地上游真实请求完成 T21，分别核对 request_id 唯一性、绑定 providerId/apiKeyId、HTTP/SSE outcome/usage 与供应商/Key 资源统计返回，不重复补写已存在的请求。
- [ ] 根据可复现证据只修具体写入/聚合/展示层；同 Key 双网关与绑定切换不改写旧归属；无测量不造 token/TTFT。
- [ ] 为 ResourceUsageModal 提取统一 loader 并接 usePageRefresh；保留范围/视图，按 scope + revision 隔离旧响应，错误/空/旧数据状态可区分并可重试。
- [ ] 区分卡片 gateway_request_events 与详情 request_logs 的窗口/口径；不相加，不把 /models 或 WS 握手当推理用量，保留原取消/本地拒绝规则。
- [ ] T22 证明打开弹窗后新数据可经页面刷新显示，失败重试与范围/供应商竞争正确。

写入范围：ResourceUsageModal.tsx/test.tsx、现有统计/handler 测试；request_logs/statistics 命令及 handler 仅在 T21 证明需要时修改。门禁：A16/A17 对应证据可追溯；不新增重复统计表，不回填来源不明的历史。

### P3：持久化与留存（依赖 P0；与 P1/P2 共享文件须串行）

- [ ] renderer 启动 epoch/seq ID、启动安装持久化桥；本地实时与落盘同 ID；只订阅 renderer 原始 bus。
- [ ] 落实批次 50 条/64 KiB、单条正文 16 KiB、缓冲 1,000 条/1 MiB、500 ms flush、仅一个 IPC 在途。
- [ ] 新增专用 renderer log 批次命令及 API/注册；后端强制来源、校验/脱敏/限长、try_send、accepted/rejected；磁盘失败不递归。
- [ ] 扩展分来源 dropped/failed/trimmed、容量淘汰与保留窗口状态；daemon 离线显示 unavailable。
- [ ] writer 加可注入时钟和维护：启动补扫、空闲 recv_timeout、持续流量 append 前检查、本地日期/时区 offset 变化重算。
- [ ] 使用 UTC 记录→本地自然日边界；历史/内存使用同一语义；新 active 不复用旧进程文件，旧混合日期 closed 文件安全整理。
- [ ] 串行化进程内维护及跨进程目录/元数据锁，临时文件唯一、原子替换；app/daemon 只删自己 closed 文件，保留原容量保护。
- [ ] 补 TTL 与容量淘汰元数据、读限制和损坏行提示；不把日切变成 generation 清空。
- [ ] 清空先排空在途 IPC/切代再清文件，新日志清空后发送；分来源确认失败，不将部分成功当作全部成功。
- [ ] 用临时目录覆盖午夜、今天/前两天边界、UTC/本地差异、offset 变化、睡眠恢复、旧文件、坏行、容量、磁盘错误、进程并发及清空顺序。

写入范围：consoleBus/持久化桥/consoleStore、console 命令、console_log_store、main 启动安装、daemon management 状态/清空及测试。门禁：隐藏窗口/无流量仍能由后台维护；代理写入只 try_send；无统计表或第三方日志等级变动。

### P4：控制台、菜单与集成（依赖 P2/P2b/P3）

- [ ] 请求/异常合并列表，异常/状态/关键词组合筛选，历史 kind=ok 的 4xx/5xx 正确失败分类；pending 与 WS 生命周期不误判。
- [ ] 独立日志列表，级别/来源/关键词组合筛选；详情复制、错误重试、有界窗口/丢弃提示和长驻过期。
- [ ] tray 第一项固定打开并聚焦，四种窗口状态保留当前页面；既有日切归零、Dock 策略不变。
- [ ] Sidebar 管理/观测视觉分组，保留原路由与观测内部导航；检查直达、刷新和高亮。
- [ ] 中英文、必要样式、CHANGELOG 与受影响规范同步；不进行全仓格式化。
- [ ] Lead 审全部 diff，核对 A1–A17、秘密脱敏、导入/保存兼容及没有范围外改动，再派发全范围 trellis-check。

## 3. 可执行工作包、文件范围与集成门禁

P0–P4 是实施阶段；下表是建议一次派发的最小工作包。默认顺序为 P0 → G-API → G-ROUTE → G-UI → M-UX → Q-STATS → L-STORE → L-IPC → C-UI → SHELL → REVIEW。日志组只在契约冻结后才可调整执行顺序；本轮不启动这些工作包。

| 工作包 | 前置条件 | 写入范围（仓库根相对路径） | 交付门禁 |
| --- | --- | --- | --- |
| G-API：网关契约/迁移 | P0 缺陷证据和设计契约明确 | src-tauri/src/models/mod.rs、db/mod.rs、db/proxy_sessions.rs、commands/gateways.rs、lib.rs；src/shared/types/index.ts；src/renderer/api/types.ts、index.ts；相关 fixture/契约测试 | SQL NULL/缺省/显式清空可区分；CRUD 签名一致；预览契约冻结但尚未公开；迁移幂等且非 gateway 不变；Rust/TS 构建不悬空 |
| G-ROUTE：解析/发现/转发 | G-API | src-tauri/src/shared_runtime/ 必要连接模块及注册；services/model_catalog.rs；commands/providers.rs 的服务调用接线；commands/gateways.rs 的预览命令与共享 API/注册接线；proxy/handler.rs；网关/认证/WS 测试 | T01–T05、T17；P0 网关分流回归转绿；内置客户端兼容回归通过 |
| G-UI：网关连接编辑 | G-ROUTE | GatewayPage.tsx/module.css、GatewayPage.test.tsx；必要只读模型列表 | T06；预览不用先保存，原字段/操作保留，无模型选择/映射控件 |
| M-UX：模型入口统一 | G-ROUTE | Keys.tsx、KeyEditModal、ModelMappingEditor、ModelCatalogManager、必要 query hook/list 及测试 | T07–T10；P0 模型链路回归转绿；保存与取消语义清楚 |
| Q-STATS：供应商线路质量 | G-ROUTE；M-UX 共享文件交接 | src/renderer/components/usage/ResourceUsageModal.tsx/test.tsx；gateway_api.rs 和统计断言；仅有复现依据时改 db/request_logs.rs、commands/statistics.rs、handler.rs | T21/T22；A16/A17；归属/计数正确且打开弹窗刷新能看到最新结果，不重复记账 |
| L-STORE：writer/TTL/状态后端 | P0 日志契约冻结；G-API 共享文件已交接 | console_log_store.rs；commands/console.rs；daemon management.rs 及相关测试 | T11–T14；受保护 active 不被删；后台空闲/持续流量均维护；状态/clear ack 真实 |
| L-IPC：renderer 写入/恢复 | L-STORE | consoleBus.ts、consoleStore.ts、拟新增持久化桥、main.tsx 及测试；commands/console.rs 的 renderer 输入校验 | T15/T16/T18；批次/缓冲有界；清空不复活、持久化失败不递归 |
| C-UI：控制台列表 | L-IPC | Console.tsx、consoleFilters.test.ts、拟新增 Console 组件测试/必要样式 | T19；过滤、请求合并、日志来源和截断提示一致 |
| SHELL：菜单/导航/说明 | G-UI、M-UX、Q-STATS、C-UI | tray.rs、Sidebar.tsx 及必要样式/测试；locales/zh.ts、en.ts；CHANGELOG.md；受影响 .trellis/spec/ | T20、H01–H04；路由/焦点行为有证据；说明与实现一致 |
| REVIEW：集成自查/独立检查 | 全部工作包交付 | Lead 审 diff；trellis-check 仅修复有证据的局部问题 | 完整质量门禁通过；验收台账逐项有结论；未执行项明确 |

表中 renderer 文件未写全路径时，均在 `src/renderer/` 下对应原目录；worker 派发必须展开成精确路径，不把整棵 src/ 当作默认写入范围。新文件先搜索可复用实现，最终路径登记后才能写入。

### 3.1 原子变更清单

G-API 一次接通 Rust DTO → CREATE/ALTER → 所有 SELECT/mapper/写入 → command/inner → invoke_handler → TS model → Api/buildApi → fixture/契约测试。UI 尚未提供新控件时，旧调用仍可省略 connectionConfig；不得为兼容 fixture 暂时丢弃读取出来的新字段。新增模型预览在 G-ROUTE 中连同真实服务、命令注册、API 和契约测试一起公开，G-API 不创建空实现占位。

L-STORE/L-IPC 共用一份日志契约：readRecent 旧字段保留，新 retention 字段有兼容缺省；logStatus/clear 的分来源结果同步后端、Api 和消费方。新增 renderer append 命令的类型、注册、API、输入校验和测试一起落地；不得先暴露只入队却声称已落盘的接口。

共享写入区包括 `src-tauri/src/lib.rs`、models/mod.rs、`src/shared/types/index.ts`、renderer api 两文件、两份 locale、CHANGELOG 及任务证据。由 Lead 或指定单一集成写入者处理；若当前工作包 owner 要直接修改，先交接所有权，其他 worker 同时不得修改。已有改动不可回退覆盖。

### 3.2 阶段检查与返工规则

- G-API：运行命令组 V1/V3；模型服务下沉前后比较旧客户端用例，迁移测试需 reopen 临时 DB，而非只测内存对象。
- G-ROUTE：运行 V1/V2 及新增 gateway 集成用例；若模型发现绿而 POST/WS 失败，不交付 G-UI。
- G-UI/M-UX：运行 V3 和相应 V4；两入口必须通过真实容器组合测试，不能仅 mock 掉待验证的查询控制器。
- Q-STATS：运行 V1/V3，以及 `cargo test -p cc-use --lib resource_statistics_scope_provider_and_key_with_quality_metrics` 和 `pnpm exec vitest run src/renderer/components/usage/ResourceUsageModal.test.tsx`；新增 T21 必须从真实 handler 到聚合，T22 必须调用实际 refreshCurrentPage。
- L-STORE：运行 V5/V6；仅同步调用 maintain(now) 证明纯函数正确还不够，至少一个有界后台调度测试证明无 Record 命令时也会触发维护。
- L-IPC/C-UI：运行 V3/V7；验证错误返回和清空代次，不以 console.error 被调用作为持久化成功证据。
- 全部包完成再运行 V8。已通过检查只在后续改动影响它或发现新问题时重跑，避免无变化反复全量构建。
- 任一门禁失败先定位最小失败层并修复，记录命令、退出码和原因；不得删断言、跳测试、吞异常或把 unavailable 写成 pass。若修复改变产品行为/公开契约，先回写设计并报告具体差异。

## 4. 测试任务目录与断言

下面 T 编号是计划中的测试组，不代表已有覆盖或已通过。优先扩展现有文件；标为“拟新增”的文件只在实施阶段创建，重命名时同步本表、命令和验收台账。

| 编号 | 现有入口 / 拟新增入口 | 必须证明的结果 |
| --- | --- | --- |
| T01 | src-tauri/tests/db_proxy_sessions.rs；db/mod.rs 内部 migration tests | 去列后的旧 schema 升级、新建/重开、marker 重跑、失败回滚；非 gateway 行/原 token/绑定/名称/启停不变；新列已有值不覆盖 |
| T02 | src-tauri/tests/gateway_api.rs | 省略 config 保持/新建默认，完整对象覆盖，null 清字段；只读 preview 不写 DB；归属/停用/耗尽/非法 URL/UA 拒绝且错误不带秘密 |
| T03 | gateway_api.rs + shared_runtime 解析单测 | 同 Key 两网关不同覆盖，Key 的 Claude Code/Codex 配置故意不同；模型与推理实际命中 gateway/provider 有效配置，model 和非模型 Body 字段不变 |
| T04 | gateway_api.rs + services/model_catalog.rs 内部 tests | /models 和 /v1/models 一致；根地址、路径前缀、尾斜杠、IPv6、query；空目录与失败区分，分页、重复游标、条数/大小限制保留 |
| T05 | src-tauri/tests/proxy_websocket.rs；gateway_api.rs | 三种认证、UA 优先级、provider additive/模板、保留头阻断、HTTP Proxy；HTTP/SSE/WS 分别捕获，WS 生成合法握手且消息 model 原样 |
| T06 | src/renderer/pages/GatewayPage.test.tsx | 显示/保存/恢复连接、预览草稿与延迟响应隔离；卡片操作保留，冗长说明移除，模型区没有选择/映射/启动控件 |
| T07 | 拟新增 src/renderer/pages/Keys.models.test.tsx；实际管理容器组合 | 供应商入口和密钥入口用同一 Key/客户端/URL/auth/UA 得到相同候选；多身份明确选择，无静默 Codex/Grok fallback |
| T08 | 拟新增共享 query hook 测试，文件随 hook 确定 | A 慢 B 快与同身份连续刷新：旧结果/错误不能覆盖新请求；UA/URL Apply 使用当前值触发重查；身份包含 provider 头/代理和凭据变更 |
| T09 | ModelCatalogManager.component.test.tsx；KeyEditModal.component.test.tsx | 拉取不新增，子视图应用只改草稿、外层保存才持久化；取消、失败、空结果和刷新保留手动/既存模型；手动 ID 校验/去重 |
| T10 | 上述 KeyEditModal 测试；src/renderer/utils/modelMapping.test.ts；src-tauri/tests/model_mapping.rs | provider/append/custom、角色/1M/映射/启动参数及不相关字段往返不变；查询偏好不被复制进转发 UA |
| T11 | console_log_store.rs 内部 tests | UTC→本地日期，今天/前两天保留、第三天淘汰；启动、空闲/高流量日切、offset 变化和恢复补扫；无效/异常未来时间不绕过 TTL |
| T12 | console_log_store.rs 内部 tests | 旧混合日期文件按记录整理，保留 ID/epoch/seq；损坏行可见；active 先关闭后处理；容量与临时文件失败不损坏原文件 |
| T13 | 拟新增 src-tauri/tests/console_log_retention.rs | 两独立进程维护锁/元数据竞争、共享读与整理/clear、同来源 writer 所有权；设置超时和 rendezvous，拒绝仅用同进程 Mutex 证明 flock 有效 |
| T14 | crates/cc-use-daemon/tests/management_api.rs；console 命令内部测试 | 状态计数/认证保留；daemon 离线可见；clear 真实完成 ack；一来源失败时返回部分失败，generation 不被并发覆盖 |
| T15 | console 命令输入校验内部 tests；拟新增 console 持久化桥测试 | 50 条/64 KiB/16 KiB 边界含多字节 UTF-8；批内非法项与整批超限、来源伪造、queue full、磁盘错误均有准确计数；落盘脱敏 |
| T16 | src/renderer/api/consoleStore.test.ts；拟新增持久化桥测试 | 跨刷新 epoch 不重 ID，实时/回放只一条，终态不退回 pending；清空过程中旧在途与新日志按代次处理，失败不递归/不无限重试 |
| T17 | proxy_handler_auth.rs、proxy_handler_console.rs、proxy_console_errors.rs；model_mapping.rs | 非网关客户端原路由/认证/映射/用量归属不退化；网关依旧不改模型，取消/拒绝/失败生命周期保留 |
| T18 | src/renderer/api/__tests__/index.contract.test.ts | 新命令正确 invoke 名称/参数；省略值不被补成 null；显式 null 不丢；DTO 新旧字段兼容；append ack 不冒充落盘 ack |
| T19 | src/renderer/pages/consoleFilters.test.ts；拟新增 Console.component.test.tsx；consoleStore.test.ts | 请求/日志分类、异常/状态交集、历史 4xx/5xx、pending/WS 状态；日志三级筛选、详情复制、TTL 长驻清理和截断/失败提示 |
| T20 | src-tauri/src/tray.rs 内部 tests；Sidebar 路由渲染用例（必要时新增） | 既有 badge 日切用例通过；固定入口回调与原路由分组正确，真实 focus 结果由 H01 补足，不用 mock focus 成功代替桌面验收 |
| T21 | src-tauri/tests/gateway_api.rs；db/request_logs.rs 资源统计内部 tests | 本地网关 HTTP/SSE→request_logs→供应商/Key 质量统计贯通；成功/错误/取消、延迟/usage、request_id 唯一和双网关/切换绑定归属；不虚构非推理/WS 用量 |
| T22 | Keys 供应商菜单容器用例（必要时新增）；src/renderer/components/usage/ResourceUsageModal.test.tsx；pageRefresh.test.ts（必要时扩展） | 首次点击传入正确 providerId，有数据/真实空/查询失败分别处理；之后页面刷新会重查并更新，保留范围/视图，延迟旧响应不污染新 scope |

测试安排补充：

- P0 可先扩展 T03/T07/T08 的旧输入回归；新 API 尚不存在时不要 import 不存在的符号制造编译失败。修复阶段再扩展新字段矩阵。
- mock 上游绑定 `127.0.0.1:0`，返回已就绪信号，测试结束关闭 listener/task；不用固定 12345/22345，不调用真实供应商。捕获器存储 method、path/query、Header 和 Body，断言不输出合成/真实密钥全文。
- fake clock 用于日期/定时器；并发测试用 barrier/ack 控制次序并设有界超时。时区测试使用显式 offset 或独立子进程，避免并行用例相互修改全局 TZ。
- 数据库/日志目录均使用 TempDb/tempfile；生产路径不可作为 fixture。统计保留回归比较 TTL/clear 前后 request_logs/usage_logs，证明不受影响。
- 旧测试若断言“启动复用活动文件/继续 sequence”等被设计明确改变的行为，应改成新 epoch 身份唯一且旧日志可回放的断言；不能整段删除测试。Keys.query.test.tsx 仍是用量查询回归，不能算 T07 的模型链路证据。

## 5. 验证命令与证据

所有命令从仓库根运行。V1–V7 优先跑现有入口，新测试落地后显式追加其路径；尤其 T07/T08/T13/T15/T19 的拟新增入口不能因本表旧命令没包含而漏跑。测试筛选必须实际命中用例；0 tests 不算通过。

| 命令组 | 用途 | 命令 |
| --- | --- | --- |
| V1 | 网关 CRUD/迁移/本地上游 | `cargo test -p cc-use --test db_proxy_sessions --test gateway_api` |
| V2 | WS/认证/透明与非网关回归 | `cargo test -p cc-use --test proxy_websocket --test proxy_handler_auth --test proxy_handler_console --test proxy_console_errors --test model_mapping` |
| V3 | TS 和 IPC 接线 | `pnpm typecheck`；`pnpm exec vitest run src/renderer/api/__tests__/index.contract.test.ts` |
| V4 | 网关/模型编辑 | `pnpm exec vitest run src/renderer/pages/GatewayPage.test.tsx src/renderer/components/keys/ModelCatalogManager.component.test.tsx src/renderer/components/keys/KeyEditModal.component.test.tsx src/renderer/utils/modelMapping.test.ts`；补跑实际新增的 Keys.models/query hook 用例 |
| V5 | writer 单测和跨进程留存 | `cargo test -p cc-use --lib console_log_store::tests`；T13 创建后追加 `cargo test -p cc-use --test console_log_retention` |
| V6 | daemon 管理/状态/清空 | `cargo test -p cc-use-daemon --test management_api` |
| V7 | 控制台投影/恢复 | `pnpm exec vitest run src/renderer/api/consoleStore.test.ts src/renderer/pages/consoleFilters.test.ts`；补跑新增持久化桥/Console 组件用例 |
| V8 | 集成完整门禁 | 下列命令逐项执行并记录退出码 |

命令组不能覆盖全部测试入口：模型服务/共享解析新增的 lib 单测、console 命令输入校验、tray 内部测试要补充对应 filter 或由全量测试明确收集，记录实际命中数量。变更 antd 组件前查 info/demo，改后对修改文件执行 antd lint；只格式化本次修改文件。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:frontend
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets
```

长命令保留 session/job id 并收集最终退出码；有失败修复后重跑关联检查。文档阶段不运行产品全量测试，不能把设计静态检查写成实现通过。

必须捕获并断言：两个不同连接的 gateway 共用一个 Key 时互不影响；Key 的 Claude Code/Codex 地址和映射故意不同且不被 gateway 使用；供应商 Header/代理、三种认证、显式/默认 UA、请求 query 和原始 model 真实到达 mock。覆盖 HTTP、SSE 取消、WS 握手及两种 /models 入口。

文件维护使用注入时钟，不靠实际跨午夜 sleep。并发至少覆盖 app/daemon 同时轮转/改 meta、读取与 closed 文件整理、clear 与 renderer 在途批次。明确区分入队 ack、flush/clear ack 与实际磁盘完成。

## 6. 验收台账与证据记录

下面所有状态均为“未实施”，不是待确认是否通过。实施后由 Lead 更新结果；新证据集中记在本任务拟新增的 `validation.md`，worker 不并发修改本文件或台账。自动化失败和环境阻塞都不能写成完成。

| PRD 项 | 自动化证据 | 手工补充 / 关键边界 | 当前状态 |
| --- | --- | --- | --- |
| A1 | T20 回调/日切回归 | H01 四窗口状态；当前页/草稿和 Dock | 未实施 |
| A2 | T06 | H02 网关必要操作与错误提示 | 未实施 |
| A3 | T17/T19 | 请求/异常只有一份列表，取消/拒绝/4xx/5xx | 未实施 |
| A4 | T19 | H02 组合筛选、日志来源、详情复制 | 未实施 |
| A5 | T14–T16/T18 | H03 刷新/重启恢复，稳定 ID、不递归 | 未实施 |
| A6 | T11–T14 | 临时目录/时钟；进程锁、活动文件与容量 | 未实施 |
| A7 | T11/T16/T19/T20 | H03 午夜隐藏/空闲；统计表前后不变 | 未实施 |
| A8 | T07–T09 | 两入口同身份、UA 重查、候选/手动项保留 | 未实施 |
| A9 | T02/T08/T09 | H02 草稿地址、恢复默认和取消 | 未实施 |
| A10 | T10/T17 | 原策略/角色/1M/启动参数及无关字段往返 | 未实施 |
| A11 | T20 | H02 原路由直达、刷新、高亮与分组 | 未实施 |
| A12 | T15/T18 和 V8 | 中英文、变更范围、秘密扫描与全部门禁 | 未实施 |
| A13 | T03–T05 | H04 DSH 实际查模并调用；mock 不能替代真实桌面记录 | 未实施 |
| A14 | T03/T05/T17 | mock 捕获 URL/auth/UA/Header/代理/model；HTTP/SSE/WS | 未实施 |
| A15 | T01/T06/T10 | 无模型编辑控件；token/绑定/启停不变，无映射迁移 | 未实施 |
| A16 | T21/T17 | 网关请求终结后从供应商/Key 质量接口核对正确归属与唯一记录 | 未实施 |
| A17 | T22 | H02 首次点击正确供应商；真实空结果正确显示，打开期间可刷新；失败与空状态分别展示 | 未实施 |

H01–H04 的具体步骤见下一节。真实桌面项无法执行时，自动化部分可以单独记 pass，但该验收项整体注明“部分通过，手工未执行”，不可笼统标全通过。

`validation.md` 每次记录使用同一结构：

```text
工作包 / T 或 H 编号：
实际改动文件与 diff 基准：
命令 / 手工操作：
环境：临时 DB/目录、mock 监听地址、构建/应用版本；不记凭据
期望与实际：关键断言、用例数量；手工状态与观察
结果：pass / fail / blocked / not_run / partial
退出码：未执行时填 not_run；有进程的同时记 session/job id
证据：脱敏后的最小输出或截图路径；不粘贴原始 Header/Body 秘密
限制 / 下一步：未执行项、失败原因、是否需要修改设计
```

首次实施时记录 git HEAD、已有修改、pnpm/Rust 工具版本和旧基线结果。红测试证据与修复后绿测试分开，说明断言如何证明故障；不只写“测试通过”。已有 jsdom pseudo-element 警告保留为已知环境噪声，退出码或实际断言失败仍需处理。

## 7. 手工验收与回滚点

| 编号 | 操作步骤 | 通过条件与记录 |
| --- | --- | --- |
| H01 窗口入口 | 在任一有未保存草稿的页面，分别隐藏、最小化、切换失焦、保持打开；逐次点击徽章第一项 | 始终显示“打开主界面”；显示/恢复/聚焦；页面与草稿未丢；Dock 策略不变；记录四种状态，mock focus 不能代替 |
| H02 界面交互 | 深浅主题分别检查网关、模型管理和控制台；滚动/搜索/键盘/复制；用无效地址重试；修改地址后查询、恢复默认、取消；直达 /gateway /stats /console 并刷新 | 列表紧凑、操作可达、无两段网关长说明；模型仅在显式保存后改变；路由和高亮正确；打开供应商线路质量后产生新测试请求并刷新页面，显示更新且保留范围/视图；复制结果符合预期且证据不包含秘密 |
| H03 留存恢复 | 使用测试构建、临时数据和可控时钟验证隐藏/空闲日切；刷新或重开测试应用读取历史；模拟容量/磁盘失败 | 旧记录过期、今日 badge 显示归零，统计表保持既有数据；请求/日志无重复；失败可见。可控时钟只能算模拟，真实跨午夜若未做要注明 |
| H04 DSH 外部客户端 | 获得实际桌面验收条件后，将测试 DSH 会话指向测试网关和本地 mock；GET 模型、选择真实 ID 发普通/流式请求，最后恢复测试设置 | 上游捕获的真实 ID/连接字段正确；不修改用户既有会话/生产配置。若需要改现有客户端设置，另行取得对应授权；本任务不会自动重配 |

手工步骤只验证本任务行为，不把 Azure 400/TPM 重试或模型输出限制加入本轮。不能执行的项按 not_run/partial 记录，说明缺的是桌面可操作条件、测试构建还是用户授权。

- P1 回滚保留新增列及已迁移连接，不删 token 或写回 Key；旧二进制忽略新列的风险在交付说明展示。
- P3 回滚停止新维护逻辑而保留兼容记录；按策略已删除日志不可恢复，不能承诺回退重建三天历史。
- 正式部署、升级/重启、提交/推送独立于本任务实施授权；未经要求不执行。

## 8. 启动、派发与续接协议

仅在用户批准实施之后执行本节。先重新读取 task.json、PRD/设计/本计划和 git status；保留用户已有修改。若工作区已变更，核对是否影响契约或缺陷证据；不要覆盖，也不自动新建第二个相同任务。

1. 用 `task.py start` 激活现有目录，并读取 `task.py current` 核实当前会话指向正确任务。若身份缺失，按脚本提示恢复当前会话身份；不借用别的会话指针、不手改状态绕过门禁。
2. 加载 Phase 2.1 细节，选一个工作包，登记依赖已完成的证据、唯一 owner、精确写入范围和共享文件交接。
3. 使用项目配置的 Trellis implement/check 角色；派发提示第一行必须是 `Active task: <task.py current 实际返回路径>`。优先使用原生上下文注入；若有截断文件提示先读文件，未注入时由子代理读取任务三文档及对应 jsonl。
4. 子代理按授权范围完成并回报；Lead 审实际 diff、收集命令最终退出码、更新 validation.md 和工作包状态，再派发下一包。检查代理局部修复后重跑相关验证。
5. 若上下文压缩/会话中断，读取本文件、validation.md、任务状态和 git diff，从最后一个有交付证据的工作包后继续。勾选进度只代表已验证结果，不用先前助手口头“完成”替代证据。

批准实施后从仓库根运行的入口命令（本轮不执行）：

```bash
python3 .trellis/scripts/task.py start .trellis/tasks/10-28-gateway-console-provider-ux
python3 .trellis/scripts/task.py current
python3 .trellis/scripts/get_context.py --mode phase --step 2.1 --platform codex
```

任务启动/身份核对任一步失败即停在该步骤处理，不执行后续派发。质量检查阶段另加载 Phase 2.2 细节，不能以 implement 代理的自测报告替代完整 check。

派发正文模板（第一行的路径必须用实际 current 输出替换）：

```text
Active task: <task.py current 实际返回路径>
Role: trellis-implement（或 trellis-check）
工作包：<G-API 等编号>；本次目标：<具体交付>
已完成依赖及证据：<工作包、T 编号、validation.md 位置>
Write scope：<逐项列出精确文件；共享文件已完成交接>
你不是唯一写入者，不得回退他人修改；发现重叠先报告并协调。
先确认注入上下文完整；否则读取 implement/check.jsonl 和任务文档。
不要创建/启动其他任务或再派发 implement/check；不要提交/发布/重启生产服务。
必跑检查：<V 组 + 实际新增测试路径>；必验行为：<T 编号及核心断言>
返回：实际改动文件、测试数量和最终退出码、未解决问题、范围/设计差异。
```

当前会话任务指针尚未激活，不在本轮运行以上启动命令或派发 worker。全量检查通过后才进入 spec 更新与交付说明；提交/归档另按用户授权及 finish-work 规则处理。

## 9. 当前状态

- [x] 原始 DSH 会话已只读核对，已确认需求均在 PRD，废弃的继承/映射备选未恢复。
- [x] 设计明确字段、整体替换/清空、迁移 marker、连接优先级、查询状态、IPC 上限、UTC/本地日边界、文件归属与锁、失败状态和回滚。
- [x] 实施/检查上下文清单路径校验通过；相关后端、前端、daemon、质量规范已纳入。
- [x] 工作包/原子变更边界、T01–T22 测试目录、V1–V8 命令组、A1–A17 台账和 H01–H04 手工验收已补齐；均未执行。
- [x] 新增 R7/A16/A17、Q-STATS/T21/T22；已记录只读现场聚合和确定刷新缺口，不声称已修复。
- [x] 更正现场解释：anyRouter 首次空结果来自 DSH any-router 实际使用 agentRouter 网关 token；已在真实应用验证近一月历史可查。保持数据真实归属，不自动更改 DSH 或补写记录。
- [ ] 用户审阅包含 R7 的设计与本实施计划并批准实施。
- [ ] 激活现有任务并按 P0 开始编码。

## 10. 续接新增：局域网访问（R8，2026-10-29）

需求见 [prd.md](./prd.md) R8/A18–A20，契约见 [design.md](./design.md) §12。第一轮 R1–R7 已实施并通过 V8 全量门禁与跨进程 E2E（见 [validation.md](./validation.md)）；本节是同一任务内新增的 P5 工作包，默认仅本机、开启 LAN 后才能被局域网访问。

### 10.1 工作包与写入范围

| 工作包 | 前置 | 写入范围（仓库根相对） | 交付门禁 |
| --- | --- | --- | --- |
| N-CORE：设置/绑定/管理隔离/代理策略 | 契约冻结 | `src-tauri/src/models/mod.rs`、`db/settings.rs`、`commands/settings.rs`、`shared_runtime/network.rs`（新）、`shared_runtime/mod.rs`、`crates/cc-use-daemon/src/runtime.rs`、`crates/cc-use-daemon/src/management.rs`、`src-tauri/src/proxy/handler.rs`、`src-tauri/src/commands/proxy.rs`（地址查询命令）、相关测试 | T23–T25；管理面 loopback 三类；LAN pass-through 403；默认回环绑定 |
| N-UI：设置/网关页展示 | N-CORE 契约（可并行按冻结契约编码） | `src/renderer/pages/Settings.tsx(.module.css)`、`src/renderer/pages/GatewayPage.tsx(.module.css/.test.tsx)`、`src/renderer/stores/settingsStore.ts`（默认值）、`locales/zh.ts`+`en.ts`（settings/gateway 分组） | 范围切换、安全提示、LAN 地址复制、空原因；中英文案配对 |
| N-E2E：真机 LAN 脚本与台账 | N-CORE | `.trellis/tasks/.../evidence/run_e2e_lan.py`；Lead 更新 validation.md | A18–A20 证据；默认回环拒绝、LAN 可用、management 403、pass-through 403 |

共享文件仍由 Lead 独占：`src-tauri/src/lib.rs`（`proxy_lan_addresses` 注册）、`src/shared/types/index.ts`、`src/renderer/api/types.ts`、`src/renderer/api/index.ts`、`CHANGELOG.md`、`.trellis/spec/**`、本任务文档。

### 10.2 测试目录（T23–T25）

| 编号 | 入口 / 拟新增 | 必须证明的结果 |
| --- | --- | --- |
| T23 | `src-tauri/tests/db_settings.rs`、`src-tauri/src/shared_runtime/network.rs` 内部 tests、daemon/runtime 层可注入的绑定选择单测 | `proxyListenScope` 缺省/非法=loopback、`lan` 读写往返；绑定地址函数 loopback→127.0.0.1、lan→0.0.0.0；LAN 地址收集过滤 loopback/link-local/0.0.0.0、私网优先、去重、接口名保留 |
| T24 | `crates/cc-use-daemon/tests/management_api.rs` | 带 loopback `ConnectInfo` 的 management 请求保持原行为；非 loopback `ConnectInfo` 一律 403（含 console clear/SSE/log-status/detail-mode/instances）；缺 ConnectInfo 的进程内测试按可信语义放行且注释说明原因 |
| T25 | `src-tauri/tests/proxy_lan_access.rs`（新）或 `proxy_handler_auth.rs` 扩展 | 非 loopback + `PassThrough`（provider 凭据）→403；非 loopback + gateway/session token →正常转发并可读 `/models`；回环 pass-through/session 行为不变；错误响应不含凭据 |
| T26 | `src/renderer/pages/GatewayPage.test.tsx` 扩展（必要时新增设置页小组件测试） | 开启显示 LAN 入口并可复制、未开启显示提示、无地址给出原因；不改变本地地址与既有卡片操作 |

### 10.3 验证命令（V9）

在 V8 全量门禁基础上追加：

```bash
cargo test -p cc-use --test db_settings
cargo test -p cc-use --lib network
cargo test -p cc-use-daemon --test management_api
cargo test -p cc-use --test proxy_lan_access
pnpm exec vitest run src/renderer/pages/GatewayPage.test.tsx
python3 .trellis/tasks/10-28-gateway-console-provider-ux/evidence/run_e2e_lan.py
```

E2E 脚本要求：临时 HOME + 真实 daemon；先以默认 scope 启动，从本机 LAN IP 连接必须失败；写入 `proxyListenScope=lan` 重启后，从 LAN IP 访问网关 `/models` 成功、LAN 访问 `/_management/health` 返回 403、从 `127.0.0.1` 访问管理健康返回 200；provider 凭据 pass-through 从 LAN 返回 403；结束后清理临时目录，不动生产数据。

### 10.4 新增台账与手工项

| PRD 项 | 自动化证据 | 手工补充 / 关键边界 | 状态 |
| --- | --- | --- | --- |
| A18 / R8 | T23 + V9 E2E（默认 scope 下 LAN IP 连接失败、回环正常） | 升级旧库/缺失字段回退 | 未实施 |
| A19 / R8 | T24/T25 + V9 E2E（LAN 网关可用、management 403、pass-through 403、回环管理 200） | 真实第二设备访问 | 未实施 |
| A20 / R8 | T23/T26 + V9 E2E（设置持久化、变更重启、地址展示） | H05 视觉/防火墙手工核对 | 未实施 |

| 编号 | 操作步骤 | 通过条件 |
| --- | --- | --- |
| H05 局域网接入 | 开启「局域网访问」，从同一 Wi-Fi 的第二台设备用网关 LAN 地址 + 网关本地 Key 获取模型并发起会话；再尝试访问 `/_management/health` | 网关可用、管理接口被拒、关闭开关后立即不可达；记录设备/地址（不含秘密）与防火墙提示 |

### 10.5 门禁与回滚

- 任一门禁失败先定位最小层；管理面隔离与 pass-through 403 属于安全边界，不允许以“UI 默认关闭”代替测试。
- 回滚：关闭 `proxyListenScope` 即回仅本机；不改数据库 schema；旧二进制忽略该设置并继续只监听回环。
- 本轮不执行真实第二设备手工验收和正式发布/重启生产 daemon；提交/归档仍等待用户授权。

## 11. 2026-10-29 五项交互返工执行计划（R9，最新）

当前状态：2026-10-30 已获用户明确实施授权，S/B/M/G/O/I 按本节实施。实际新证据记录于 validation.md §14；旧报告不算本轮测试结果。T01–T26 保留兼容回归，已被替换的 UI 断言按本节调整，不删除数据正确性检查。

### 11.1 启动条件、工作包与顺序

1. 获批后确认工作目录、任务指针和 Git 基线；按 Trellis 恢复已有任务，保留全部未提交改动，不 reset、不新建重复任务。
2. 读取对应层 spec 和组件；核对 antd 6.2.3 的 Table、Select、Checkbox、确认弹窗 API/demos，不升级依赖。先补当前缺口的回归用例。
3. Lead 先做 S/B 契约和后端：供应商模型清单持久化/显式连接查询、网关策略 CREATE/ALTER/DTO/IPC/校验，再接代理。不能先发只有字段没有真实校验的限制开关。
4. S/B 契约稳定后，M（模型）、G（网关）、O（请求/日志/导航）和 I（图标）可按以下不重叠范围推进；O 可先独立开展。使用团队时先登记依赖和 write_scopes，读取最新 revision 后认领，不让代理自行改变审批状态。
5. Lead 集成共享 API/注册/中英文与 fixture，检查完整数据流和最终 diff；先针对性测试，再完整质量检查及可执行的视觉核对。

| 单元 | 有界写入范围 | 依赖与交付 |
| --- | --- | --- |
| S 共享集成（Lead） | [TS DTO](<src/shared/types/index.ts>)、[API 类型](<src/renderer/api/types.ts>)、[API 构造](<src/renderer/api/index.ts>)、API 契约测试、[Rust 注册](<src-tauri/src/lib.rs>)、Rust models、locale、CHANGELOG、任务文档 | 模型清单/查询、网关 modelPolicy、图标删除的命令/类型成套接通；其他单元只提交所需接口/文案清单，不并发改共享文件。 |
| B 数据与策略（Lead） | DB migrations/mapper、provider 模型清单新模块、provider/gateway 命令、shared_runtime 策略模块、[模型服务](<src-tauri/src/services/model_catalog.rs>)、[代理 handler](<src-tauri/src/proxy/handler.rs>)、相关 Rust 测试 | 依赖 S 契约；清单保存不改 Key；旧网关默认全部、坏策略不放开；严格模式上游零绕过；只读模型发布与原始推理分开。 |
| M 模型 | [Keys.tsx](<src/renderer/pages/Keys.tsx>)、keys 模型组件、外层独立模型窗口新文件、查询 hook、模型领域 store 和相关测试 | 依赖 S/B 接口；把获取真正搬到外层，窗口内选 Key/URL/UA；映射/Key 选择只读保存清单；三个草稿/保存边界及旧配置保留。不要编辑 I 的 ProviderModal/ProviderIcon。 |
| G 网关 | GatewayPage 页面/样式/测试 | 依赖 S/B；消费清单选择全部/指定，不再查询或预览；默认 Bearer、高级覆盖、已有字段不重置；保存策略与严格模式兼容提示。 |
| O 观测与导航 | Console/ActivityPage、独立日志页/helper、Sidebar/TitleBar/WorkspaceLayout 及测试、[App.tsx](<src/renderer/App.tsx>) | 可独立；真 Table、滚动跟随/暂停、紧凑单层路由、分页面会话筛选。统计与全局 consoleStore 以回归保护为主，不复制后台管线。 |
| I 图标 | [ProviderModal.tsx](<src/renderer/components/providers/ProviderModal.tsx>)、[ProviderIcon.tsx](<src/renderer/components/providers/ProviderIcon.tsx>)、图标工具/缓存、[system.rs](<src-tauri/src/commands/system.rs>) 及 helper/测试 | 接口与 S 协调；服务端在用引用/路径检查；成功才更新列表/缓存/草稿。只用临时目录，不触碰真实用户图标。 |

### 11.2 本轮验收矩阵

| 编号 / 对应项 | 证据入口 | 必须覆盖 |
| --- | --- | --- |
| T27 / A21 | Sidebar 路由/高亮测试 + 后续视觉核对 | 网关间距与普通菜单一致；观测三入口唯一；折叠/窄窗口无额外 wrapper 留白。 |
| T28 / A8–A10/A22 | 外层窗口、Keys、ModelCatalogManager/ModelMappingEditor/KeyEditModal、store/query/modelMapping、API contract；模型服务与清单 DB 测试 | 只有外层主动查询；Key/URL/UA 真实到 mock，A/B 身份旧响应隔离；获取不保存；清单持久化/重开/冲突；下游不查询；手工/旧 ID 保留；子应用后未保存 Key 可映射；provider/append/custom/角色/1M/启动不变。 |
| T29 / A13–A15/A23 | GatewayPage + gateway_api、gateway_connection、proxy_websocket、策略/helper/迁移测试 | 默认全部/Bearer且无需获取；无预览；指定集合持久化和本地目录一致；JSON HTTP/SSE 已选原样成功、未选 403 且上游零命中；缺少/错误/重复 model、未知方法/路径、编码/别名/压缩体、WS 升级均不可绕过。旧 NULL 全部、坏策略失败、更新省略保持、空指定集合拒绝；切换绑定/清单刷新不放开。 |
| T29-b / A14/A23 | 已建立 WS + 动态策略更新集成测试 | 全部模式 text/binary/协议协商保持；改为指定后旧 WS 下一应用帧不能继续到上游并关闭，不能仅拦新握手；授权前已放行 HTTP/SSE 可正常结束。不同网关互不影响。 |
| T30 / A24 | Console/日志/ActivityPage/TitleBar/路由；consoleFilters/consoleStore/consoleLogBridge/Statistics 回归 | table/th/td、稳定 rowKey、生命周期合并；交集筛选/详情/Escape/复制/跟随/暂停；独立路由/标题/筛选，当前页 refresh；历史恢复、截断、离线/丢失/部分清空失败；全局清空不伤统计。 |
| T31 / A25 | ProviderModal/ProviderIcon/providerIcon、API contract、system 临时目录/TempDb | 未引用可删，取消/失败不误删；草稿回退；保存引用和旧路径识别；内置/穿越/符号链接/目录/目录外拒绝；缓存失效、延迟 read/list 不复活、重开一致；命令真实注册。 |

### 11.3 命令与运行边界

- 用 `pnpm exec vitest run <具体已存在测试路径>` 跑 T27–T31；新文件落地后记录真实路径和数量，0 tests 不算通过。
- 前端：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build:frontend`；另执行改变的 antd 组件检查。已核对 [package.json:6–28](<package.json#L6-L28>)：`test` 含 Vitest 和构建/发布说明脚本测试，`build` 是 Tauri 打包，不是前端构建。
- Rust：`cargo fmt --all -- --check`；清单/策略/图标 helper 对应真实测试过滤；`cargo test -p cc-use --test gateway_api --test proxy_websocket`；`cargo test --workspace`，需要时按规范 clippy。只 check 全树格式，不自动格式化覆盖旧改动。Tauri 打包不是本轮默认动作，不安装或发布。
- 本地 mock 上游、合成 Key、TempDb、临时图标目录；不访问真实供应商、不清生产历史、不改生产连接、不重启 daemon。配置或 WebSocket 变更用测试实例验证。
- 视觉核对明暗主题、侧栏收起、窄窗口、长 ID：请求 Table、独立模型管理/下游选择、网关基础/高级表单、三页导航、图标确认。jsdom/源码不是 WebView 验收；环境不足标未执行，不启动替代 DSH 服务。
- 记录时间、命令、实际命中数量和失败原因，区分既有失败与新回归。本轮尚未运行这些产品检查，环境 doctor 不作为验收结果。

### 11.4 风险与回退

- 供应商清单不是客户端完整目录或所有 Key 的权限证明；刷新/删项不传播为配置删除。独立查询也不写入连接配置。
- 严格模式先拒绝原样 WS 和不支持的协议；全部模式保留兼容。后续适配只能在具备完整模型校验后放行，不能开默认旁路。
- 新表/列增量保留旧数据；限制启用后降级到不识别策略的旧二进制可能失去限制，必须先停用相应网关，不承诺无损/安全热降级。认证不新增 default/auto，不重跑旧连接迁移。
- Table 真实滚动节点、页面 refresh 和筛选状态是回归重点；保留全局清空及容量/三日提示。
- 图标确认删除不可逆；在用资源服务端阻止，外层取消不恢复文件。回退只撤本轮明确修改，不触碰原有未提交内容或自动删新 schema。



## 12. R9 本轮执行结果（2026-10-30）

- [x] 用户批准最新计划；恢复已有任务，不新建重复任务。
- [x] S/B：清单持久化/显式查询、policy CREATE/ALTER/DTO/IPC、严格代理与已有 WS 后续帧校验。
- [x] M：独立供应商模型管理；Key 目录/映射只读保存清单、当前草稿及手动/已有 ID。
- [x] G：全部/指定暴露、Bearer 默认与高级连接，无模型获取/预览。
- [x] O：真正 Table、三页独立导航、会话筛选、紧凑侧栏；保留日志/统计基线。
- [x] I：上传图标确认删除、服务端引用/路径保护、缓存/列表代次失效。
- [x] T27–T31 自动回归、前后端全量门禁、独立复核修复、规范与 CHANGELOG 同步。
- [x] 合成 IPC 静态浏览器预览：明暗主题、折叠/窄窗口、长 ID、网关/模型窗口、请求/日志与图标确认。
- [ ] 实际 Tauri WebView、真实第二设备/DSH 的人工验收：未运行，不能由 mock 或 Chromium 替代。
- [ ] 提交/发布/安装/归档：按 PRD 明确边界不自动执行。

完整命令、实际数量、复核补记、截图和未执行项见 validation.md §14。provider 模式的选择新增 editor-only `catalog.draftModels`，设计 §13.5 记录原因及兼容性断言。


## 13. R10 交互收敛实施计划

- [x] O：Console.tsx / Console.module.css / 组件测试，整理工具条与状态层级，保持投影/筛选/持久化；窄窗口日志详情改为响应式堆叠，消息列不再被固定 380px 详情挤没。
- [x] G：GatewayPage.tsx / CSS / 测试，重组表单与卡片摘要；保存 busy 只归属本次写入，迟到列表不再覆盖或释放后续保存，写入期间锁定全部草稿控件，失败保留可编辑草稿。
- [x] M：用户已确认“Key 里只保留选择和映射”；核对并保留已完成的入口收敛，修复 provider 旧 runtime 元数据与显式 Desktop 角色兼容，补 CRUD/取消/策略回归。
- [x] Lead：集中整合 locale、记录设计调整与文档；独立 trellis-check、相关测试、全量 typecheck/lint/test/build 与合成截图。
- 不重跑未变化的 Rust 全量门禁；本轮无 Rust/DB/IPC/共享类型改动，R9 的 Rust 报告仅作历史基线。

实际命令、数量、修复清单、视觉指标与未执行的人工项见 validation.md §15。


## 14. R10 二次反馈实施结果（2026-10-31）

- [x] Key 去掉“模型目录来源”；勾选即白名单、清空回落供应商目录，旧 provider/append 未修改选择时保持原模式。
- [x] 删除 `/logs` 页面/路由/导航/标题映射，日志并入控制台持久化视图；移除 R10 过度筛选、状态条与日志详情。
- [x] 控制台恢复终端单行流并改用主题 token，浅色/深色均跟随主题；保留搜索、暂停/继续、刷新、清空与请求详情。
- [x] “查看模型”改名“模型清单”；网关默认 Bearer 不变（按用户后续反馈不新增说明文案）。
- [x] 更新 Console/Sidebar/Key/ActivityPage 回归，完成全量 typecheck/lint/test/build 与合成明暗/窄屏截图。

实际命令、数量与截图见 validation.md §16。
