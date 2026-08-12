# Changelog

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [3.8.0] - 2026-08-12

### Added

- 供应商和密钥卡新增多折线用量趋势，可按近 7 天、本月或全部时间在同一张图比较 Token、请求数、成功率、缓存命中率与平均延迟
- 线路摘要新增平均首 Token 时间，供应商级汇总全部密钥，密钥级保持独立归因

### Changed

- 供应商 / 密钥质量统计的请求总数包含无 Token 的失败请求，使成功率使用完整且可解释的分母
- 全局用量统计的每日趋势由柱状图改为多折线图，同图展示 Token、请求数和缓存命中率，并在悬停时显示当日全部实际值
- 补充竞品能力审视，后续优先考虑全局多维筛选、只读托盘额度和显式 User-Agent 覆盖

### Fixed

- 托盘后台刷新重新与菜单重建解耦，并主动检测本地自然日切换；无新请求且窗口隐藏时，昨日 Token 也会在 30 秒内清空
- Claude Code 状态栏会正确引用包含空格的应用路径；第三方配置覆盖后必须通过回读校验才提示启用成功

## [3.7.0] - 2026-08-04

### Added

- 新增 `cc-use claude` 与 `cc-use grok` 终端入口，支持方向键选择启动线路、默认选中 GUI 当前线路，并可通过 `q` 取消
- Claude Code 新增用户可选的双行彩色状态栏，展示供应商、Key、实例、模型、Git 分支与上下文进度，并支持安装、更新、重新安装和卸载
- 用量统计新增失败请求、Key/项目维度、自定义日期和上月快捷查询，年度热力图统一展示每日 Token
- Codex Desktop 接管新增供应商真实模型目录，并为 DeepSeek V4 Flash / Pro 提供可用的思考强度选择

### Changed

- 用量统计收敛为真实 Token 与请求结果，不再展示或计算估算费用；历史费用字段继续保留，升级不会删除旧数据
- 仪表盘改为展示今日 Token、请求数和失败数，Token 数量统一使用易读的本地化格式
- Codex 接管继续保留密钥级上游模型映射，仅替换模型名称，不进行 Chat 或 Claude 协议转换
- CLI 安装直接使用随应用提供的可执行文件，避免首次安装或重新安装时现场编译卡住

### Removed

- 移除周/累计热力图模式、费用计算器与费用相关设置入口
- 移除未使用的 `discovered_sessions` 数据表，不影响请求、Token 与历史用量记录

### Fixed

- 多客户端密钥同时启用 Codex 与 Claude 时，模型列表测试优先使用 Codex 路径，避免 Codex 模型被错误过滤
- Codex Desktop 接管时保留官方登录信息，并写入模型目录所需配置，解决选择器只显示“自定义”的问题
- 状态栏重新安装不再触发编译流程，终端选择器在无法读取 TTY 时会回退到当前终端交互

## [3.6.0] - 2026-07-31

### Added

- DeepSeek 官方接入成为内置供应商预设，自动配置 Claude Code、Claude Desktop 与 Codex Desktop 的端点、认证方式和模型映射
- Codex DeepSeek 接管内置官方模型目录，默认使用 `deepseek-v4-flash`，并保留 cc-use daemon 的热切换、统计和恢复能力
- 新增统一线路选择器，可按供应商、密钥和模型搜索，并明确显示当前线路与客户端兼容性

### Changed

- Codex Desktop 与 Claude Desktop 启动台收敛为“客户端 → 供应商 → 密钥 → 模型”线路视图
- Claude Code 与 Grok 项目的下次启动线路改用双栏选择器，不再使用随供应商数量增长的滚动菜单
- “API 密钥”页更名为“供应商与密钥”，继续承载 CRUD、排序、余额、用量、模型列表与高级映射
- DeepSeek 官方预设仅面向 Codex 与 Claude 系列，不出现在 Grok 线路中

### Fixed

- 修复 Codex Desktop session 使用 `codex-app` 标记时无法读取密钥 `clientConfigs.codex` 专用上游配置的问题
- Claude Desktop 接管后会持久化当前密钥，重新打开页面仍可正确展示当前线路
- 修复统一线路选择器左侧供应商列表无法滚动的问题
- DeepSeek Codex 接管完成后明确提示完全重启桌面端，避免启动时模型目录尚未加载导致选择器空白

## [3.5.1] - 2026-07-29

### Changed

- 供应商模型列表改为明确选择 API Key，默认使用第一把可用 Key，并按所选 Key 的上游地址和认证方式读取模型

### Fixed

- Claude Desktop 配置接管不再主动探测供应商，供应商暂时不可达或本地 daemon 未运行时仍可完成本地配置写入
- 修复供应商 Base URL 已包含 `/v1` 时模型列表端点被重复拼接为 `/v1/v1/models` 的问题

## [3.5.0] - 2026-07-26

### Added

- 实例页新增当前实例与最近结束记录视图，可查看 `stopped / failed` 终态、停止原因和退出码
- 托盘分别展示 Claude Code 与 Grok Build 的 running、launching、stale 实例数量
- WebSocket 转发新增上游握手前置、子协议协商、关闭帧透传、HTTP / HTTPS CONNECT 代理和代理基础认证
- 用量统计新增缓存读取、缓存创建、缓存命中率和缓存费用，最近请求同步展示缓存 Token
- 新增 Claude Opus 5 / Sonnet 5、GPT-5.6、Grok 4.5 与 GLM-5.2 当前默认价格

### Changed

- 原 v3.6 透明网关稳定性并入 v3.5，统一交付实例、网关与费用确定性
- 项目页明确只修改下次启动默认线路，实例页热切换只影响当前运行实例
- CLI wrapper 在启动前命令期间持续上报 launching 心跳，CLI 真正启动后才进入 running
- 内置价格只保留 Claude 4.6+、GPT-5.4+、DeepSeek V4、Grok 4.5 与 GLM-5.2
- Claude Sonnet 5 限时价按日期切换，OpenAI 与 Grok 长上下文请求按官方阶梯计价

### Fixed

- 修复晚到 heartbeat 复活终态实例、重复 stop 覆盖首次终态，以及实例线路与 proxy session 非原子更新的问题
- 修复客户端取消后 Console 长期停留 pending、并发许可延迟释放和已确认 SSE usage 未结算的问题
- 修复逐跳 Header 转发、大小写 SSE Content-Type、无空格 `data:`、跨 chunk UTF-8 / JSON 与压缩响应解析问题
- 修复 WebSocket 在上游失败前先向客户端返回 101，以及未复用供应商代理配置的问题
- 修复 OpenAI / xAI 缓存 Token 重复计入普通输入，补齐 DeepSeek cache hit / miss 与 GLM-5.2 缓存 usage 解析

## [3.4.0] - 2026-07-26

### Added

- 仪表盘与用量统计新增 Token / 费用双主指标，可在本机保存选择并跨页面复用
- 日趋势、月历、年度热力图与密钥、供应商、项目、模型排行同时支持 Token 和费用视角
- Dashboard 聚合新增累计 Token，日/月趋势统一返回 Token、费用和请求量
- Claude 模型映射新增“具体模型 ID → 上游模型 ID”高级精确映射，并同时作用于 Claude Code 与 Claude Desktop

### Changed

- 「费用统计」调整为「用量统计」，默认优先展示输入 Token 与输出 Token 之和，缓存 Token 保持独立并继续参与费用估算
- 排行表与最近请求根据当前主指标调整列顺序和视觉权重，两种指标始终保留
- 「近 7 天」统一为今天及前 6 个本地自然日，「本月」统一从本月 1 日起计算
- Claude Desktop 改为通过当前供应商的 `/v1/models` 发现具体模型，不再由 CC Use 固定生成 Sonnet、Opus、Haiku 和 Fable 四个条目
- Claude 模型映射统一按“精确映射 → Opus / Sonnet / Haiku 家族映射 → 原模型透传”匹配，并移除 `default` 兜底

### Fixed

- 修复统计汇总和排行按所选时间范围变化、趋势图却固定展示近 30 天的问题
- 修复快速切换时间范围或统计单位时，较早返回的请求可能覆盖当前结果的问题
- 修复密钥模型映射全部清空后旧值仍保留在数据库的问题
- 修复升级后当前生效的 Claude Desktop 接管 profile 继续残留旧固定模型和映射显示名的问题

## [3.3.4] - 2026-07-22

### Added

- 项目新增自定义分组，可直接输入新分组或复用已有分组；历史项目和空分组统一归入「未分组」
- 补充中英文 Grok Build 接入指南与 3.3.4 版本文档，覆盖自定义模型配置、启动方式、响应兼容和常见排障

### Changed

- Grok Build 改为在用户级 `~/.grok/config.toml` 维护 `cc-use` 自定义模型，使用 OpenAI Chat Completions 后端并以前台 TUI 方式启动
- Claude Code 与 Grok Build 的实例列表、兼容密钥和手动清理按各自启动台隔离；后端同时拒绝跨客户端密钥绑定
- Token 数量按语言显示：中文使用「万 / 亿」，英文使用 `K / M / B`，悬停提示保留精确整数
- 项目弹窗移除重复的 Claude Code / Grok Build 绑定说明；普通 HTTP `User-Agent` 原样透传行为补充回归测试与文档

### Fixed

- 修复供应商成功率为 `100%` 时中心文字与圆环边框重叠
- 修复 Grok Build wrapper 将交互进程放入后台导致终端空白或无法正常交互
- 修复部分 OpenAI 兼容上游在普通或 SSE Chat Completions 响应中遗漏 `model`，导致 Grok Build 报反序列化错误
- 限制 Grok SSE 跨分块规范化的单行缓存大小，避免异常上游长期不换行时阻塞客户端并持续占用内存

## [3.3.3] - 2026-07-16

### Changed

- Claude Code 与 Grok Build 复用同一个项目目录，但供应商、API Key、终端和启动前命令改为按客户端独立保存，切换客户端不再覆盖另一侧绑定
- 项目列表按项目路径的上级目录自动分组，供应商页在每个供应商标题旁展示近 24 小时真实上游请求成功率、请求数和错误数
- 费用统计页移除放错位置的全局网关成功率卡片；本地拦截请求不计入供应商成功率分母

### Fixed

- 修复 Grok Build 使用不存在的环境变量导致启动后空白；改为写入官方支持的 `~/.grok/managed_config.toml` 自定义模型，并通过 `grok -m cc-use` 启动
- 修复 Grok Build 的复制命令仍生成无效 Base URL 环境变量，代理模式改用受管模型和独立 session token
- 修复托盘用量后台计算完成后从工作线程直接更新 UI，导致定时刷新、请求后刷新和窗口聚焦刷新不生效；现在统一回到 Tauri 主线程更新

## [3.3.2] - 2026-07-16

### Added

- 新增 Grok Build 启动台与项目终端启动链路；通过 `grok` 命令注入本地 `/v1` 代理地址和 session token，并与 Claude Code 共享项目、实例和会话工作区
- API Key 新增 Grok Build 适用客户端、客户端专属 Base URL、Bearer 鉴权覆盖和独立模型映射；Grok session 只允许使用已勾选 Grok Build 的密钥
- 密钥页支持复制 Grok Build 代理模式与直连模式命令，代理转发支持 Grok 的模型列表和 OpenAI 风格请求

### Changed

- 密钥编辑弹窗的适用客户端改为紧凑多选框，最多展示两个标签，其余选项折叠为数量提示
- Claude Code 与 Grok Build 继续共享项目列表，但项目弹窗和卡片快速切换菜单按当前启动台过滤可选密钥

### Fixed

- 修复 Grok Build 项目卡片仍能选择未勾选 Grok 的密钥；选择密钥或打开项目时会同步 Grok 启动类型，并阻止不兼容密钥启动

## [3.3.1] - 2026-07-13

### Added

- Codex Desktop 支持 API Key 级单一上游模型映射；只在实际转发给中转站前改写 OpenAI Responses 请求中的 `model`，不改变 Codex Desktop 的模型列表或其他前端行为，并与 Claude 的 haiku / sonnet / opus / default 语义映射互不影响

### Changed

- GitHub Release 正文改为自动提取 `CHANGELOG.md` 中当前 tag 对应版本的完整更新内容，并保留 macOS 未签名提示；版本缺失、重复或内容为空时会在构建前阻止发布
- API Key 与 provider token 恢复使用 SQLite 明文存储；已被 3.3.0 移入 Keychain 的凭据会在升级时一次性写回 SQLite，成功后日常读写不再访问系统 Keychain，避免持续出现权限提示

### Removed

- 移除新凭据的 Keychain 写入、读取和删除链路；保留只读兼容迁移以恢复已经由 3.3.0 写入 Keychain 的历史凭据

## [3.3.0] - 2026-07-13

### Added

- 内置 GPT-5.6 Sol、Terra、Luna 模型价格及通用 `gpt-5.6` 别名，覆盖输入、输出、缓存读取和缓存写入费用
- macOS Keychain 凭据存储：API Key 与 provider token 不再以明文写入 SQLite，旧数据启动时自动迁移
- 新增基于真实转发流量的近 1 小时、24 小时、7 天网关指标，统计请求量、成功率、错误分类、平均/P95 延迟、活跃供应商与最近活动
- 新增 PR 级 CI，校验前端类型、ESLint、Vitest 以及 macOS Rust 格式与 workspace 测试

### Changed

- 上游 HTTP Client 按代理配置复用连接池，增加连接、空闲连接与 TCP keepalive 边界，不设置推理总超时或自动重试
- 配置导出默认剔除 API Key 与可能含认证信息的请求头；显式包含明文凭据时显示风险提示
- session 路由改为每次请求从数据库强校验 provider、API Key、managed instance、撤销与过期状态；Desktop 与 managed session 使用独立生命周期
- 网关近期指标使用有界异步写入队列，最多保留 30 天/5 万条，不阻塞实际请求

### Removed

- 删除供应商 base URL 主动延迟探测、自动探测 effect、手动刷新按钮与定时轮询 hook；不再产生用户未发起的供应商请求

### Fixed

- 修复托盘今日费用只有“最新请求”路径能刷新，补齐窗口获焦、托盘点击与 30 秒兜底刷新
- 限制请求体、普通响应、压缩流捕获、解压内容和控制台详情内存；SSE usage 改为有界增量解析
- 增加全局与单 session 并发限制，许可覆盖完整 HTTP、SSE 与 WebSocket 生命周期，超限返回本地 429
- managed instance 停止、失败或超时后立即撤销 session；恢复 Desktop 官方配置时撤销并轮换 token

## [3.2.7] - 2026-07-10

### Fixed

- 修复 API 密钥「客户端配置」中的上游认证方式保存后丢失，导致 `Authorization: Bearer` / `x-api-key` / 不发认证头覆盖不生效的问题

## [3.2.6] - 2026-07-09

### Added

- API 密钥客户端配置新增「上游认证方式」覆盖，可为单个客户端强制走 `x-api-key` / `Authorization: Bearer` / 不发认证头，兼容默认头部不匹配的自建网关（如只认 `ANTHROPIC_AUTH_TOKEN` 的 Claude 兼容网关）；不配置时行为与之前一致

## [3.2.5] - 2026-07-06

### Fixed

- 修复 provider_type 移除后代理认证头按 URL 误判的问题；Claude Code / Claude Desktop 恢复使用 `x-api-key`，Codex Desktop Responses 使用 `Authorization: Bearer`
- 修复 cache-only usage 不进入请求日志的问题，并补齐 OpenAI `prompt_tokens_details.cached_tokens` 解析
- 控制台请求新增稳定 requestId 与 pending/final 合并；流式请求开始时即可显示，完成后原地更新并保留详细模式内容
- 流式响应中途错误时，控制台会把 pending 请求更新为 upstream_error，不再静默丢失
- 托盘今日费用改为窗口获焦时立即刷新，并移除冗余的定时刷新循环
- 修复 Claude Code 项目 Tab 内项目列表无法滚动的问题

## [3.2.4] - 2026-07-02

### Fixed

- 修复 Claude Code 项目卡片密钥切换下拉在 antd v6 分组菜单中点击不生效的问题
- 修复项目卡片密钥切换下拉长列表无法稳定查看底部密钥的问题；下拉改为固定高度容器内滚动，并补齐边角裁切

## [3.2.3] - 2026-07-02

### Added

- 供应商新增 HTTP 代理配置，支持为每个供应商单独配置代理地址（如 `http://127.0.0.1:7890`）
- API 密钥新增客户端专用 Base URL 覆盖，支持为 Claude Code、Codex、Claude Desktop 分别配置不同的端点

### Fixed

- 修复密钥选择下拉框（KeyCascader）在多密钥场景下无法滚动导致底部密钥无法选中的问题
- 修复供应商编辑时 HTTP 代理字段为空值时保存报错的问题
- 删除 providers 和 api_keys 表中废弃的格式转换字段（type、api_format、transform_enabled），简化代理鉴权逻辑

## [3.2.2] - 2026-06-30

### Added

- 控制台新增错误过滤、请求/响应详细模式与敏感信息脱敏，支持查看代理请求头、请求体、响应头和解析后的响应内容
- Codex Desktop / Claude Desktop 供应商列表支持按供应商探测上游延迟；当前接管供应商自动探测，其余供应商可手动刷新
- 设置页新增 daemon 启用开关，关闭后不再由启动流程或 watchdog 自动拉起

### Changed

- 控制台流式响应详情改为优先展示 SSE 中的实际模型输出，不再把 `message_start` / usage 元数据当作响应正文展示
- 设置页本地代理服务区域收敛文案，daemon 开关说明改为问号悬浮提示
- 顶栏与托盘的代理状态在 daemon 启停、端口变更后立即刷新

### Fixed

- 修复 Claude Code / Claude 兼容流式响应在 gzip 压缩或 UTF-8 chunk 边界拆分时 usage 无法入账的问题
- 修复费用统计、今日消耗和趋势在 UTC 入库、本地日期展示时的跨日错位问题
- 修复控制台详细模式中响应头缺失、gzip SSE 响应体显示乱码或只显示元数据的问题
- 修复响应详情脱敏把 `input_tokens` / `output_tokens` 等普通字段误打码的问题
- 修复 daemon 开关关闭后 UI 仍显示运行中、顶栏状态保留旧错误的问题；关闭时会等待端口真正释放，失败则回滚设置
- 修复 Claude Code 项目密钥选择下拉无法滚动的问题

## [3.2.1] - 2026-06-29

### Added

- Claude Code 项目新增「启动前命令」配置，wrapper 会在进入项目目录后、执行 `claude` 前运行该命令；失败时中止启动并上报 `prelaunch_failed`
- Codex Desktop / Claude Desktop 启动台支持拖拽调整供应商和同供应商下的密钥顺序

### Changed

- 托盘 badge 收敛为只显示今日消耗，不再显示代理异常、活跃实例数或今日请求数
- 新增供应商不再默认 DeepSeek，改为 Claude 类型且余额查询默认关闭
- Codex Desktop / Claude Desktop 接管表格精简为「密钥 / 状态 / 操作」，移除无实际数据的级别和延迟列，接管操作左对齐
- Claude Code 启动前命令从全局/key 配置收敛到项目编辑中；历史 `prelaunchCommand` 字段仅过滤保留，不再参与启动或导出为环境变量

### Fixed

- 停用供应商或密钥时，桌面接管按钮禁用并显示明确状态原因

## [3.2.0] - 2026-06-26

### ⚠️ Breaking

- **移除 Codex CLI 启动链路**：应用入口收敛为 Claude Code / Codex Desktop / Claude Desktop 三客户端；旧的 `/launch`、`/launchpad`、`/projects`、`/instances`、`/sessions` 路由统一重定向到 Claude Code 页面
- **移除请求/响应格式转换层**：删除 `proxy/transform/*` 与 `transform_bridge`，不再提供 Anthropic Messages / OpenAI Chat / Codex Responses 之间的运行时转换；上游供应商需要兼容目标客户端的原生 API 形态
- **供应商不再承担客户端适用性配置**：客户端适用性收敛到 API Key 的 `types`，供应商侧格式转换配置 UI 下线，遗留 DB 字段仅用于兼容旧数据

### Added

- **三客户端主导航**：Sidebar 直接提供 Claude Code、Codex Desktop、Claude Desktop 三个入口，另有统一的「供应商密钥」页面
- **Codex Desktop 配置接管重做**：
  - 写入 `~/.codex/config.toml` 的 `cc-use` provider、`wire_api = "responses"` 与稳定 `experimental_bearer_token`
  - 接管时备份 `config.toml` / `auth.json`，但不改写 `auth.json`，保留官方 ChatGPT 登录和插件能力
  - 固定 session token 持久化到 settings；已接管后切换密钥只更新 daemon session 指向，无需重启 Codex Desktop
  - 新增配置预览命令与页面按钮
- **Claude Desktop 配置接管重做**：
  - 写入 Claude 3P profile、`_meta.json` 和相关配置，网关地址指向 `/claude-desktop`
  - 写入 `inferenceModels`，支持 haiku / sonnet / opus / fable 默认路由，并把 API Key 模型映射同步为 `labelOverride`
  - 接管前探测本地 daemon 的模型列表接口，失败时阻止写入无效配置
  - 清理 Claude 3P 配置中的旧 `isHardwareAccelerationDisabled` 字段，避免新版 Claude Desktop 启动卡住
- **Claude Code 页面重组**：项目、实例、会话和全局配置收敛到 Claude Code 页面 Tabs；全局配置编辑从「供应商密钥」页移出
- **密钥编辑体验重做**：密钥弹窗改为基础 / 模型映射 / Claude Code 局部配置 Tabs，客户端适用性使用 Claude Code / Codex Desktop / Claude Desktop 多选
- **配置接管通用组件**：Codex Desktop 与 Claude Desktop 共享按供应商分组的密钥选择、当前接管状态、供应商/密钥排序和配置预览
- **统计对桌面客户端更友好**：无项目的 Codex Desktop / Claude Desktop 请求在 Top Projects 和请求明细中显示为对应客户端，而不是 Unknown
- **价格与模型识别扩充**：新增 Claude fable/mythos、Claude 4.x 细分版本、GPT 5.x / chat-latest 等默认价格；模型价格匹配支持去除 `models/`、`anthropic.`、`openai.`、`bedrock.` 等前缀

### Changed

- `ApiKey.types` 默认值从旧 `claude` 迁移为 `claude_code`，并支持 `claude_code / codex / claude_desktop` 三种 `ClientKind`
- Claude Code 仍是唯一进程级启动客户端；`ProviderTypeConfig` 只保留 Claude Code 终端注入配置
- 代理层改为直透客户端原始请求形态，并按供应商类型 / URL 判断使用 `Authorization: Bearer` 还是 `x-api-key`
- 代理层移除请求头中的 `content-length`，响应转发过滤 hop-by-hop header，避免代理转发时长度与流式响应不一致
- 上游 URL 拼接避免 `/v1` 等路径重复；Claude Desktop 请求会剥离本地 `/claude-desktop` 前缀后再转发
- Claude Desktop `/claude-desktop/v1/models` 由本地 daemon 直接返回模型列表，避免依赖上游模型接口
- Codex Desktop 的 `/v1/responses` 请求在缺少显式 session token 时，会回退到 settings 中保存的接管 session
- 用量解析支持 OpenAI Responses 的嵌套 `response.usage` 和 streaming 事件；响应缺少 model 时使用请求 model 兜底
- 统计和仪表盘过滤 0 usage 的探测请求，避免模型列表或健康检查污染费用数据
- 托盘菜单、设置、控制台日志与 daemon 管理文案同步三客户端/配置接管语义

### Removed

- 删除旧 Quick Add 弹窗、供应商预设派生逻辑、独立 Providers 页面和相关测试
- 删除 Codex CLI 相关的前端拷贝命令展示；桌面客户端统一引导到对应页面执行配置接管
- 删除供应商层 API 格式选择与「启用格式转换」开关

### Fixed

- 修复 API Key DB 读取列顺序与 `types` 迁移不一致导致的密钥字段错位风险
- 修复 Codex Desktop 接管后恢复官方配置时没有同步恢复 `auth.json` 备份的问题
- 修复 Codex Desktop 已接管后切换密钥仍提示必须重启的问题
- 修复 Claude Desktop 模型列表、模型映射和 1M 支持信息缺失导致的接管后模型不可见问题
- 修复 OpenAI Responses streaming usage 无法入账、费用明细显示 unknown model 的问题

## [3.1.4] - 2026-05-25

### Added

- 模型名称语义映射：API 密钥级别支持按 haiku/sonnet/opus/default 四类别模糊匹配并改写请求中的 model 字段，前端提供结构化表单配置
- 代理层自动剥离 Claude Code 的 `[1M]` 上下文标记，避免上游 API 拒绝不识别的模型名

### Fixed

- 代理认证 Header 按 Provider 类型分流：claude 类型只发 `x-api-key`，codex 类型只发 `Authorization: Bearer`，解决企业网关因多余认证头拒绝请求的问题
- 修复 `build_provider_upstream_url` 中非标准端口号被丢弃的 bug

### Changed

- 模型映射从 Provider 级别迁移到 API Key 级别，粒度更细

## [3.1.3] - 2026-05-09

### Added

- Provider 拖拽排序：filter tab 支持 @dnd-kit 拖拽重新排序，新增 `sort_order` 列和 `provider_reorder` 命令
- Provider 模型列表展示：Keys 页支持从 `/v1/models` 获取并展示可用模型列表
- 乐观更新：拖拽排序先本地重排再异步持久化，避免闪一下
- 测试：Rust 集成测试 `provider_reorder_sequence` + vitest 纯函数 + 渲染测试

### Changed

- Keys 页 filter bar 从 Ant Design Segmented 替换为 @dnd-kit 自定义实现
- 新增依赖：`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`

## [3.1.2] - 2026-04-30

### Added

- daemon watchdog：daemon 崩溃后自动恢复，不需要手动重启 app
- `request_logs` / `usage_logs` 90 天自动清理策略，避免本地数据库无限增长
- 余额查询新增 DeepSeek 类型

---

## [3.1.1] - 2026-04-27

### Added

- 仪表盘热力图重构，支持滚动 12 月视图与年份切换
- 全局错误边界 catch 处理

### Changed

- 进一步清理 Windows 相关遗留代码

### Fixed

- 代理层启用自定义定价，补齐 deepseek-v4 模型默认价格
- 项目页移除密钥切换成功提示（启动器页面无需实时反馈）
- 实例页密钥选择器只显示供应商 + 密钥别名，不展示类型后缀
- 控制台时间按本机时区显示
- 无备注项目卡片补占位，减少留白感

---

## [3.1.0] - 2026-04-19

### ✨ Added

- **实时控制台**：新增独立控制台页面，把代理请求和 daemon / app / renderer 日志聚合成单一事件流；事件缓冲挂在模块级，切页面不会清空
- **标题栏状态 pill**：窗口顶栏常驻显示 daemon 服务状态
- **设置页代理端口热修改**：修改端口后自动重启 daemon，无需手动干预
- **Claude Code Status Line 集成说明**：README 补充如何把 `CC_USE_INSTANCE_LABEL` 展示到 statusLine（作者本人使用 [claude-hud](https://github.com/jarrodwatts/claude-hud)），方便多开窗口时识别当前 managed instance

### Changed

- 设置页卡片重组：原「代理端口」与「本地服务」两张卡片合并为单张
- daemon 二进制随 app bundle 一起打包，安装后开箱即用

### Fixed

- 修复 dev / prod 两套 daemon 共存时的 `ConnectionRefused` 启动失败闭环

---

## [3.0.0] - 2026-04-17

### 🎉 重大重构 - 独立 Daemon 架构

代理不再是 app 内嵌子进程，而是抽离为独立常驻进程 `cc-use-daemon`。app 仅作 control plane，daemon 作 data plane，彼此通过 management token 通信。实例身份在启动时显式确定（wrapper + session token），取代事后推断的 PID/观测路径。

### ⚠️ 破坏性变更

- **正式放弃 Windows 平台支持**：自 3.0 起不再打包 Windows 产物（仅发布 macOS 的 `dmg` / `app`），后续版本也不再提供 Windows 构建，停留在 2.x 的 Windows 版本不会再收到更新
- **Windows 终端支持全量移除**：`cmd` / `powershell` / `wt` 三种 `TerminalType` 已删除，仅保留 `iterm2` / `terminal`（`isWindowsTerminal`、Windows 版 `formatEnvCommand` 分支一并清理）
- **移除「代理自动启动」开关**：`GlobalSettings.autoStartProxy` 删除，daemon 由应用托管，设置页代理开关改为「状态只读 + 重启」
- **代理术语改名为 daemon 服务**：README、托盘菜单、设置页文案统一
- **旧代理实验能力全部下线**：`config injection` / PID observation / discovered sessions / 全局代理开关均删除，daemon 只管理从 app 启动的 managed instance
- 项目页修改密钥不再广播到所有运行中 session，改为仅更新「下次启动默认值」；当前运行实例的热切换统一收敛到「实例」页

### ✨ Added

- **`cc-use-daemon` 独立进程**：新 crate `crates/cc-use-daemon`，含 launchd 管理、management API、runtime 启停、stale sweeper
- **Managed Instance 生命周期模型**：新增 `managed_instances` 表，状态机 `launching / running / stale / stopped / failed`，字段含 `session_token / shell_pid / process_pid / last_seen_at / stop_reason / exit_code`
- **Wrapper 脚本机制**：终端启动改为执行临时 wrapper，自动注入实例专属环境变量、持续上报 heartbeat、`EXIT/HUP/INT/TERM` 主动 stop 上报
- **Instances 页面**：展示 managed instances 列表、实时状态、实例级密钥热切换
- **`shared_runtime` 模块**：拆出 `launch_preview` / `project_session` / `management_token` / `route_plan` / `session_token` / `upstream_routing`，app 与 daemon 共享纯逻辑
- **`daemon_client`**：app 侧封装，统一走 management token 访问 daemon
- **Sidebar 新增实例入口**；`useServiceStatus` hook 统一服务状态订阅
- **项目卡片密钥切换菜单重做**：按供应商分组、分隔线、计数 badge、当前项高亮
- **新增 `sub2api` 预设供应商图标**
- **`AppErrorBoundary` 错误边界**，避免单点异常炸掉整个渲染树
- **测试基建全面扩充**：
  - Rust 集成测试：`db_api_keys` / `db_projects` / `db_providers` / `db_proxy_sessions` / `db_settings` / `managed_instances_db` / `cost_calculator` / `daemon_client` / `database_bootstrap` / `launch_preview` / `management_token` / `project_session` / `proxy_handler_auth` / `route_plan` / `session_token` / `terminal_launch_preview` / `usage_parser`，以及 daemon crate 的 `management_api` 测试
  - 前端测试：`Instances.test.tsx`、`AppErrorBoundary.component.test.tsx`、`api/index.contract.test.ts`、`scripts/smoke.test.ts`
  - 新增脚本入口：`pnpm test:web` / `pnpm test:rust` / `pnpm test:all`，Rust 测试改为 `cargo test --workspace`

### Changed

- Cargo workspace 重构：`Cargo.lock` 从 `src-tauri/` 上提至仓库根，新增 workspace 成员 `crates/cc-use-daemon`
- `proxy/handler.rs` 路由层大改：收敛为「显式 session routing + pass-through」两类，移除事后推断
- `cost_calculator` / `usage_parser` / `balance_service` / `import_export` / `usage_service` 全面重构，逻辑上抽出可测试单元
- DB 层继续抽取 `row_to_*` 辅助函数，`api_keys` / `projects` / `providers` / `proxy_sessions` / `request_logs` / `settings` / `usage_logs` 模块化精简
- 终端启动链路 (`terminal/mod.rs`) 全面重写，对接 wrapper + managed instance
- 托盘菜单文案 / 能力随 daemon 术语调整，并精简平台分支
- CI (`build-test.yml`) 构建矩阵与脚本同步更新
- `release.sh` 与打包流程适配新 workspace 结构

### Removed

- Windows NSIS 打包配置与 `tauri.windows.conf.json`
- `src-tauri/src/terminal/windows_terminal.rs`、`src-tauri/src/terminal/cmd.rs`
- 旧代理实验路径相关代码：`config injection`、PID observation、discovered sessions、全局代理自动启动等设置项
- `shared/types` 下已失效的单元测试（随 `TerminalType` 收敛）

### Fixed

- 动态切换密钥在代理侧的竞态路径：路由依赖显式 session token 而非事后 PID 猜测，彻底消除「换 key 后首个请求走旧 key」
- 启动链路失败可观测性：新增 `failed` 状态，不再把启动失败当作「运行中」

---

## [2.3.2] - 2026-03-31

### Fixed

- 同步 pnpm-lock.yaml，移除残留的 autoprefixer 条目（修复 CI frozen-lockfile 构建失败）
- 消除 Rust 生产代码中所有危险的 `.unwrap()` 调用，防止 Mutex 中毒导致 proxy 崩溃
- `HeaderValue::from_str().unwrap()` 改为安全处理，避免非 ASCII API key 导致 panic
- DB 写入后 re-fetch 使用 proper error 替代 `.unwrap()`
- 消除静默吞错误：proxy 用量记录、终端启动日志、导入导出操作失败改为日志记录或用户提示
- 设置加载/保存失败时显示用户提示（之前仅 console.error）
- Keys.tsx `as any` 类型断言改为类型安全的展开

### Changed

- `provider_get()` 从全表扫描改为直接 `WHERE id = ?1` 查询
- 提取 `row_to_project`/`row_to_provider`/`row_to_api_key` 辅助函数，消除 DB 层重复映射代码
- `add_field!` 宏统一定义在 `db/mod.rs`，移除三处重复定义
- 删除未使用的 `SessionManager` 和 `parse_session_token` 死代码
- tokio features 从 `"full"` 精简为实际使用的 5 个 feature
- 移除未使用的 `autoprefixer` 依赖
- Sessions.tsx 全部硬编码中文字符串改为 i18n，支持中英双语
- GlobalConfigModal.tsx 硬编码中文改为 i18n

## [2.3.1] - 2026-03-31

### Fixed

- 修复快速添加供应商无效的问题

## [2.3.0] - 2026-03-30

### Added

- 模型映射补充，完善模型名称映射表
- 快速添加供应商体验优化，改善一键创建供应商和首个密钥的交互流程

### Fixed

- 修复费用统计分页显示异常
- 修复 JSON 配置修改后不生效的问题
- 修复密钥页面供应商筛选器在供应商数量过多时无法横向滚动的问题

## [2.2.0] - 2026-03-27

### Fixed

- 修复 SSE 流式请求中 input_tokens 始终为 0、output_tokens 不准确的问题（根因：TCP chunk 分片导致 JSON 解析失败，新增跨 chunk 行缓冲拼接）

### Changed

- 简化费用计算系统：移除从中转站同步模型价格的功能，改为纯官方价格表 + 用户自定义价格 + 倍率计算
- 费用统计页标注"仅供参考"，明确费用为基于官方价格的估算值

### Removed

- 移除供应商级模型价格同步功能（pricing_sync_service）
- 移除供应商卡片上的"编辑模型价格"按钮（全局自定义价格仍可在统计页编辑）

## [2.1.0] - 2026-03-26

### Added

- 新增会话管理页面，扫描 `~/.claude/projects/` 下所有会话文件，展示磁盘占用、消息数、首条消息等信息
- 支持按项目、大小、时间筛选会话，支持批量删除
- 支持按时间（30/60天前）或按数量（每项目保留N个）快捷清理
- 智能解析 `sessions-index.json` 索引，兼容直接扫描 JSONL 文件的回退模式

## [2.0.7] - 2026-03-24

### Added

- 新增快速添加功能，可在一个弹窗内同时创建供应商和首个密钥

### Fixed

- 修复供应商和密钥编辑时未自动去掉前后空格的问题

## [2.0.6] - 2026-03-24

### Added

- 代理服务器新增 WebSocket 代理支持，双向转发 Codex CLI 与上游 Provider 的 WebSocket 连接，消除 WebSocket 回退警告

### Fixed

- 修复动态切换供应商/密钥时代理仍使用旧供应商地址的竞态条件（session/provider/key 查询合并到同一个 DB 锁内）
- 消除 Codex CLI `OPENAI_BASE_URL is deprecated` 警告，改用 `-c` flag 传递 `openai_base_url`

## [2.0.5] - 2026-03-19

### Added

- 密钥自定义额度查询支持 JSON 路径映射表，可映射 `remaining`/`total`/`used`/`isUnlimited`/`expireAt` 等字段，兼容非标准 API
- 密钥编辑弹窗：费用倍率 + 额度查询配置收入折叠面板，减少表单视觉负担

### Fixed

- 修复 NewAPI `unlimited_quota` 字段读取：优先读 `unlimited_quota`，支持 bool/number/string 多种类型
- 修复额度显示 `null.toFixed()` 崩溃问题

## [2.0.4] - 2026-03-18

### Added

- 添加 dev 启动标识符
- 供应商余额查询支持自定义 baseUrl

### Fixed

- 修复动态切换密钥时请求记录仍显示首次打开密钥的问题
- 修复动态切换密钥时统计数据未正确更新的问题

## [2.0.3] - 2026-03-11

### Fixed

- 解决 mac 上未正确打开项目目录的问题

## [2.0.2] - 2026-03-01

### Added

- SSE 流式请求费用记录：代理服务器在转发 SSE 流的同时解析 usage 并记录费用，解决流式请求费用丢失问题

### Changed

- 移除前端代理自动启动：打开项目时不再自动启动代理，改为提示用户手动开启

### Removed

- 清理未实现的密钥自动切换死代码（`is_retryable_error`）

## [2.0.1] - 2026-02-28

### Added

- 数据导入导出：支持选择导出内容

### Fixed

- 修复 Windows 上自定义标题栏关闭/最小化/最大化按钮不显示的问题
- 修复 mac Dock 与窗口显隐联动异常
- 修复 mac Intel 构建并统一产物命名

## [2.0.0] - 2026-02-28

### 🎉 重大重构 - 从 Electron 迁移到 Tauri

这是 CC Use 的完全重写版本，从 Electron 迁移到 Tauri 2.x，采用 Rust 后端。

### ⚠️ 破坏性变更

- **架构完全变更**：从 Electron + Node.js 迁移到 Tauri + Rust
- **自动数据迁移**：首次启动时自动检测并迁移 1.x 数据（需保留旧数据目录）

### ✨ 核心优势

**更可靠的自动更新机制**

- ✅ 应用内检查 GitHub Releases（latest.json）
- ✅ 应用内下载并展示进度
- ✅ 基于 `tauri-plugin-updater` 的签名校验
- ✅ 跨平台统一的更新检查与下载逻辑（macOS / Windows）

### 🔧 技术变更

- **框架**：Electron → Tauri 2.x
- **后端**：Node.js → Rust (axum, rusqlite, tokio)
- **数据库**：better-sqlite3 → rusqlite
- **代理**：Express → Axum + Hyper
- **更新**：electron-updater → `tauri-plugin-updater`（latest.json + 签名校验）

### ✨ 功能一览

- **供应商与密钥管理**：统一管理供应商和 API 密钥，支持额度查询与快速复制密钥配置
- **项目管理**：项目绑定供应商/密钥/CLI 类型，支持快速切换
- **一键启动**：点击项目启动终端，自动注入环境变量
- **本地代理**：内置代理服务器，通过 session token 中转请求
- **费用追踪**：代理模式下自动记录 Token 用量与费用
- **统计分析**：仪表盘与统计页提供多维度分析与请求明细
- **系统托盘**：关闭最小化到托盘，代理持续运行，托盘菜单支持代理控制与最近项目
- **CLI 配置管理**：支持全局配置与密钥级配置（JSON）合并注入
- **自动更新**：应用内检测/下载更新，展示下载进度（签名校验）
- **国际化 / 深色模式**：中英文界面与亮/暗色主题切换

### 📚 迁移指南

详见 [guides/MIGRATION.md](./guides/MIGRATION.md)

---

## [1.5.0] - 2026-02-11

### Added

- 模型价格编辑器：支持添加/编辑自定义模型价格（$/1M tokens）
- 供应商级模型价格覆盖：本地成本记账支持「供应商覆盖 > 全局自定义 > 内置默认」优先级
- 自动更新权限提示：当应用目录无写入权限时给出引导（建议移至 ~/Applications）

### Changed

- 本地使用量/成本记账与价格同步逻辑优化
- 应用内更新流程与设置页更新状态展示优化

### Fixed

- 修复 macOS 上自动更新流程无法闭环的问题

## [1.4.3] - 2026-02-11

### Fixed

- 修复 macOS 任务栏图标丢失
- 修复本地记录中部分供应商记录失效

## [1.4.2] - 2026-02-10

### Added

- 添加价格设置

### Changed

- 检查更新优化

### Fixed

- 修复任务栏图标显示异常
- 修复价格统计不正确

---

## [1.4.1] - 2026-02-10

### Changed

- 复制终端命令弹窗样式优化

### Fixed

- 修复 Windows 平台图标显示问题

---

## [1.4.0] - 2026-02-09

### Added

- 密钥复制功能：支持快速复制已有密钥配置，一键新增同一供应商下的密钥
- ESLint + Prettier 代码规范：统一代码风格，提升代码质量
- 托盘图标优化：调整托盘图标样式，支持 macOS Template 图标

### Changed

- 优化应用加载体验：改善启动时的窗口显示流程
- 优化自动更新和构建 release 产物流程
- 术语统一：「服务商」统一更名为「供应商」

### Fixed

- 修复开发模式热更新时窗口失效问题
- 修复 Chrome DevTools 控制台报错
- 修复密钥频繁变化导致的代理异常问题
- 修复供应商弹窗横向滚动条显示异常
- 修复全局设置页点击下载更新失效的问题

---

## [1.3.0] - 2026-02-08

### Added

- Windows 安装快捷方式：NSIS 安装器显式创建桌面和开始菜单快捷方式，支持自定义安装目录
- 终端命令适配多终端类型：复制的导出命令根据设置中的默认终端类型生成对应格式
  - iTerm2 / Terminal (macOS)：`VAR="val" command`（Unix inline 风格）
  - PowerShell / Windows Terminal：`$env:VAR="val"; command`
  - CMD：`set VAR=val && command`
- 复制命令弹窗标题显示当前终端类型标签，复制成功提示包含终端类型信息
- 默认终端类型自动检测：Windows 平台默认 PowerShell，macOS 默认 iTerm2

---

### Fixed

- windows 白屏修复

## [1.2.0] - 2026-02-08

### Added

- 应用内自动更新：检测到新版本后在应用内下载安装包，无需跳转浏览器
- 自动检查更新：启动后 30 秒检查、休眠唤醒时检查、窗口获得焦点时检查（最小间隔 12 小时）
- 更新横幅通知：发现新版本时在页面顶部显示蓝色横幅，点击可跳转设置页下载
- 下载进度显示：设置页显示下载百分比和速度
- 更新缓存管理：设置页显示已下载安装包数量和大小，支持手动清除
- 自动清理旧版本：应用启动时自动删除已安装版本的旧安装包

### Changed

- electron-builder 构建配置：publish 改为 GitHub provider，自动生成 latest.yml 元数据
- GitHub Actions：release workflow 增加 yml/yaml/blockmap 文件上传

---

## [1.1.0] - 2026-02-08

### Fixed

- 修复 codex 401 报错

### Added

- 系统托盘支持：关闭窗口时最小化到托盘，代理服务持续运行
- 托盘菜单：显示/隐藏窗口、代理状态显示与控制（启动/停止）、最近项目快速启动终端
- 设置页新增「关闭到托盘」开关，可控制关闭窗口时的行为
- 代理状态实时同步：托盘操作代理后，渲染进程自动更新状态

---

## [1.0.0] - 2026-02-07

全新 Electron 桌面应用，完全重写，与旧版 cc-switch / cc-use CLI 不兼容。

### Added

- Electron 桌面应用，提供完整的可视化管理界面
- 供应商管理：支持 Claude Code 和 Codex CLI 两种类型，可配置 Base URL、Token、图标等
- API 密钥管理：每个供应商支持多个密钥，支持优先级排序、耗尽标记、独立配置
- 项目管理：创建项目并绑定供应商和密钥，支持拖放文件夹快速创建
- 本地代理服务器：基于 Express，使用 session token 中转请求，避免暴露真实密钥
- 费用追踪：自动记录每次 API 请求的 Token 用量和费用，支持 Claude、OpenAI 等模型定价
- 统计分析：仪表盘展示今日费用/请求量/每日趋势/Top 密钥和项目；统计页提供按密钥/供应商/项目/模型的详细分析
- 热切换：不重启终端即可切换项目使用的供应商或密钥
- 终端集成：根据供应商类型自动设置环境变量（ANTHROPIC*\* 或 OPENAI*\*）并启动终端，支持 iTerm2、Terminal.app、Windows Terminal、cmd
- 钱包余额查询：支持 NewAPI（账户级/密钥级）和自定义接口查询余额
- 导入导出：备份和恢复供应商配置
- 国际化：支持中文和英文界面
- 深色模式：支持亮色/深色主题切换
- SQLite 本地数据库存储（better-sqlite3 + Drizzle ORM）

### Changed

- 从 CLI 工具重构为 Electron 桌面应用
- 技术栈从 Bun + Go 模板切换为 Electron + React 18 + TypeScript
- UI 框架使用 Ant Design 6 + Tailwind CSS 4
- 状态管理使用 Zustand
- 数据存储从 JSON 配置文件改为 SQLite 数据库

---

## 旧版 cc-switch / cc-use CLI 历史记录

以下为旧版 CLI 工具的变更记录，仅供参考。v1.0.0 与旧版不兼容。

### [0.1.3] - 2026-01-28

- `update` 命令支持自动检测权限问题并提示使用 sudo 重试
- 文档补充 `update` 命令的使用说明和 sudo 相关提示

### [0.1.2] - 2026-01-28

- 新增 `export` 命令，支持导出配置到 JSON 文件
- 新增 `import` 命令，支持从 JSON 文件导入配置
- Shell 补全支持 export/import 命令

### [0.1.1] - 2026-01-28

- 新增 `uninstall` 命令，支持一键卸载 cc-switch
- Shell 补全支持（zsh/bash/fish），安装时自动配置
- 修复补全文件不会随版本更新的问题

### [0.1.0] - 2026-01-28

- 初始版本发布
- 支持管理多个 Claude Code 配置文件
- 支持配置切换功能
- 支持 macOS (ARM64/x64)、Windows (x64) 和 Linux (x64) 平台
