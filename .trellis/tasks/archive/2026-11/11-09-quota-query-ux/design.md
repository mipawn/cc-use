# 查询交互与运行边界设计

## 1. Change Boundary

最小行为缺口：用户目前必须直接维护脚本，关闭密钥查询会丢失配置，草稿无法联网测试，密钥结果可能混入账户余额/周期窗口，配置改变后旧缓存仍可能显示为有效。

行为所有者：查询方案与归属规则属于 Rust shared_runtime；启用状态与缓存有效性属于数据库/查询服务；草稿测试属于服务与 Tauri API；方案选择、凭据提示、测试状态属于 renderer。不能只在 UI 隐藏错误结果。

范围只包括查询配置、查询服务、必要 IPC/持久化、两个编辑弹窗、查询结果展示和相关测试。不重做模型管理、客户端连接、推理协议或网关；不新增供应商接口或依赖；不读取开发者真实数据库或凭据。现有未提交 Command Code 修复、升级与测试必须完整保留。

## 2. Persisted Contract

复用已有 `walletBalanceScript` / `usageScript` 存储脚本，不引入两份运行脚本。

两类实体新增可选 `queryConfig`（数据库 `query_config TEXT NULL`）：

```ts
interface QueryConfig {
  enabled: boolean
  schemeId: string // catalogue id or "custom"
}
```

- Provider / ApiKey、Create / Update、Export DTO 与 Rust/TS 镜像同时更新。
- 配置整体替换；Update 省略 `queryConfig` 表示保持原值；`{enabled:false,schemeId:...}` 明确关闭但保留脚本。无需用 null 或空脚本表达关闭。
- 旧记录 `queryConfig == null`：非空脚本保留历史启用意图、空脚本关闭；归类不改写原文；明确属于账户查询的旧密钥脚本例外，停止执行并提示。
- 有配置但未知 schemeId 或 scope 不匹配不能默默执行其他方案。脚本原文保留并给出可修复状态。
- 新建无明确选择时默认关闭。用户在查询区明确选择内置方案后启用；切换供应商初始化预设只是预填，不绕过这一规则。
- 关闭保存后方案和脚本仍在本地；恢复时使用原文，不从新版目录重新生成。打开/保存不静默升级脚本。
- Create/Update、复制、带/不带稳定 ID 的导入路径和导出携带配置；不扩展真实凭据的导出范围。
- 修复 Rust `DefaultKeyConfig` 与 TS `usageScript` 不一致；密钥默认值不得再回退到账户余额示例。只有明确的独立密钥配置可预填，预填不等于启用。

## 3. Query Catalogue and Compatibility

新增 Tauri-free `shared_runtime/query_schemes.rs`，复用 `account_scripts` 文本生成，不在 TS 复制模板。

目录项：`id`、`scope: account|key`、本地化 label/description key、必需凭据列表、是否有周期用量、完整脚本文本。API 返回具类型目录；查询方案不读 `presetId` 推断能力，不修改初始化预设的非查询字段。

首批账户方案复用现有 DeepSeek、New API、OpenCode Go、Command Code；密钥目录只提供现有 New API `/api/usage/token/` 独立额度方案及自定义。New API `/api/usage/token` 无尾斜线是账户接口，不能混同。

识别以完整模板相等/明确历史模板证据为准，不以名称、图标、presetId 或仅使用 `apiKey` 为依据；无法识别的脚本归为自定义且原文不变。账户接口归属校验同时用于保存/测试/刷新：对已知账户模板及已知账户目的接口，密钥端拒绝执行；迁移原文不删。检测可复用离线 resolve_request(s)，但不得执行联网请求来猜归属。

其他自定义密钥脚本保留进阶入口，说明用户必须保证返回当前密钥额度；密钥运行变量只有 baseUrl / 当前 apiKey，不借用 provider token 或 userId。不能从任意自定义响应可靠推断业务归属，这是保留自定义能力的边界，不通过猜接口解决。

## 4. Runtime and Draft Test

保存继续调用离线 `provider_script_check`：仅验证脚本结构/GET/目标安全，不发请求。类型补齐单请求与多请求报告。

新增独立命令 `query_schemes` 和 `query_test`，完整接入 command registration、Api 类型、buildApi 与契约测试。

草稿输入契约：

```ts
interface QueryTestInput {
  scope: 'account' | 'key'
  baseUrl: string
  httpProxy?: string
  script: string
  apiKey?: string
  accessToken?: string
  userId?: string
  providerId?: string // account only: optional saved fallback-key lookup
}
interface QueryTestResult {
  scope: 'account' | 'key'
  usage: UsageData | null
  isValid: boolean
  invalidMessage: string | null
  error: string | null
}
```

- 仅点击测试时发 GET；不创建/更新 Provider 或 ApiKey，不写查询缓存、不改变检查时间，不借用刷新命令测试草稿。
- 账户测试优先显式草稿 apiKey；需要时在短 DB lock 中获取现有最低 priority、启用且未耗尽的 fallback key，之后释放锁。无可用凭据明确提示。新账户尚无密钥时可在测试区输入仅供草稿测试的 API Key，不将其另存为正式推理密钥。
- 密钥测试使用当前表单 apiKey，不回退供应商 token，不接受账户 userId/token。providerId 不得在 key scope 用来借账户凭据。
- 测试与正式刷新复用同一 script resolver、credential check、HTTP client/proxy/timeout、extractor、错误处理；测试入口不能弱化目标限制。
- 所有请求各自校验 HTTPS/供应商 origin（保留引擎现有经证实例外）；只能 GET。必需失败使整次失败，可选失败仍按现有 null 语义，不重写现有多请求行为。
- 测试结果只返回规范化额度字段，不回显原始响应、headers、完整带凭据 URL 或脚本执行文本。错误和 invalidMessage 经凭据脱敏；不打印请求凭据。
- `isValid:false`、缺少数据、网络失败均不能显示为成功或虚构 0。密钥最终 usage 去除 windows/groups，且不接受仅返回周期窗口而无密钥额度的脚本为成功。

## 5. Cache Validity and Async Races

数据库更新层负责失效，不能只比较 renderer 打开的旧对象：

- Key 的 value/script/queryConfig 改变 → 清空 cachedUsage / lastUsageCheckedAt。
- Provider 的 baseUrl/httpProxy/token/userId/script/queryConfig 改变 → 清空账户缓存与时间；地址/影响密钥查询的配置改变还清空关联密钥缓存。
- 当前被账户查询借用的密钥发生新增、删除、凭据、启用/耗尽或 priority 改变，导致有效 fallback credential 改变 → 清空账户查询缓存。相同配置重复保存不无故清缓存。
- 配置/启用状态改变与清缓存在同一事务提交。可显式清 SQL NULL，不能用现有 `Option` partial-update 当作 clear。
- 正式刷新开始时捕获有效查询输入快照；await 后在短锁内重读并比较，再写缓存。期间地址/凭据/脚本/开关变化则丢弃旧结果，不能重新污染刚失效的缓存；不持 DB lock across await。
- 保存后的首次刷新/更改后刷新依赖当前保存记录是否启用且无有效缓存；修改 key value 同样触发。关闭不刷新。
- 同一配置查询失败保留上次已知成功数据（既有契约），但 failure 不能变成 success；不同配置的旧数据不能继续显示。

## 6. Renderer Interaction

共享查询配置组件负责开关、方案选择、能力说明、凭据缺失说明、自定义入口、显式测试和结果状态，scope 参数决定目录和结果，不共享账户凭据字段。

供应商编辑将“账户余额与用量”从高级代码区独立呈现；New API 显示账户 token/userId，其他账户方案解释所需 API Key 来源。高级网络设置仍保留，不改变非查询配置。

密钥标签改为“密钥额度”；只展示独立密钥能力。关闭或未支持时显示操作说明，而非灰色代码框；只有选择自定义/基于方案自定义才出现编辑器。旧密钥账户脚本显示禁用/修复提示，可查看原文但不能执行。

测试状态以输入 revision 管理。修改地址、代理、凭据、方案、脚本、开关、打开另一条记录或关闭弹窗立即失效；迟到响应只有匹配当前 revision/输入快照才落地。测试成功不标记为已保存。

供应商结果保持账户余额/周期；密钥卡片、预览和测试仅显示独立额度、单位/无限额/到期，不渲染 ProviderUsageWindows，也不使用供应商账户缓存兜底。

所有新增文案同时维护 zh/en，使用现有 antd v6 组件与主题，不增加硬编码文案；组件 API 先用 antd CLI 查证。样式仅涉及查询区，不做无关整体重排。

## 7. Expected Write Scopes

- Backend: `shared_runtime/query_schemes.rs` / exports、`services/query_test.rs` / exports、balance/usage 服务、`commands/balance.rs` / lib registration。
- Persistence: `models/mod.rs`、`db/mod.rs`/providers/api_keys、必要 query_config migration、`services/import_export.rs`、DefaultKeyConfig、相关 Rust fixtures/tests。已有 Command Code 变更在原内容上增量整合。
- Frontend contract: `src/shared/types/index.ts`、`src/renderer/api/{types,index}.ts` 及 API tests。
- Frontend UI: 共享 query 配置组件、ProviderModal、KeyEditModal、apiKeyEditor/providerQuery helpers、查询状态 helper、Keys 页面/ProviderCard、locales 与必要 CSS/tests。
- Documentation: CHANGELOG、对应 backend/frontend specs、task 验收记录与 Trellis journal。

多人执行必须按文件划分互不重叠的写域；接口先落地，再交 UI。Lead 负责最终 diff、格式化协调、全量验证。

## 8. Rollout / Rollback

仅增加可空配置列，不破坏旧脚本或删除列；新旧数据兼容测试覆盖空列、显式关闭、未知 scheme、旧账户密钥。升级不调用网络。

现有 Command Code upgrade 独立执行且不被本任务回退；之后查询 scope 规则仍应阻止它作为密钥额度执行。

回滚代码保留新增列与原脚本。旧版会忽略新增关闭状态并以非空脚本运行，不能声称旧版本仍遵守新关闭/密钥边界；若需降级，须显式处理这一风险，不能自动清用户原文。
