# Command Code 接口调研（2026-11-06）

## 已验证的外部资料

- [Provider API 官方文档](https://commandcode.ai/docs/provider)：服务入口为 `https://api.commandcode.ai/provider/v1`；支持 `/chat/completions`、`/responses`、`/messages`、`/models`；Bearer 在所有路线可用，Anthropic `/messages` 也接受 x-api-key。cc-use 保存的 baseUrl 应按现有路由补全规则再核对，不能直接假定需要包含 `/v1`。
- [Usage Limits 官方文档](https://commandcode.ai/docs/resources/usage-limits)：CLI `/usage` 显示账户 credit balance 和 5h / weekly 窗口；额外按量 credits 不受窗口限制，按量账号不应虚构滚动窗口。
- 这两篇官方文档没有给出账户余额/用量查询的两个 HTTP 接口、认证详情或 JSON 响应结构；页面中的 `/usage` 是 CLI slash command，不能当作 HTTP API 地址。
- 抓取方式：web_fetch 输出先被侧栏导航截断；Python urllib 请求返回 403；curl 使用标准浏览器 UA 成功获取公开文档 HTML，HTMLParser 仅提取 main 正文。未使用用户凭据，未读取账户私有页面或发送推理请求。

## 代码证据

- [query_script.rs:187–231](<src-tauri/src/services/query_script.rs#L187-L231>)：当前只取 `.request` 并调用 `.extractor(response)`。
- [balance_service.rs:35–84](<src-tauri/src/services/balance_service.rs#L35-L84>)：执行前检查凭据/HTTPS 同源，复用代理 HTTP 客户端；非 2xx 和 JSON 解析失败返回错误。
- [balance.rs:7–32](<src-tauri/src/commands/balance.rs#L7-L32>)：保存检查不联网；DTO 目前返回单个 `{url, method, headers}`。
- [balance.rs:54–71](<src-tauri/src/commands/balance.rs#L54-L71>)：失败或 isValid=false 不覆盖旧缓存。
- [account_scripts.rs:13–20](<src-tauri/src/shared_runtime/account_scripts.rs#L13-L20>)：旧 AccountScript 组成方式只表示一个请求，应保持原迁移契约，新增多请求模板不强迫旧模板重写。

## 候选方案（未获最终产品决策，不是实施指令）

- 旧 `request` 保持原 extractor 入参；新增具名 `requests` 对象，extractor 接收同名响应映射，可组合余额和窗口。
- 若两个接口独立，静态请求集合已足够，无需开放沙箱 fetch、异步 JS 或响应驱动请求。
- 若第二个请求依赖第一个的 token/id，需要研究受控串行步骤；不能在没有接口证据时擅自设计链式认证。
- 建议必要接口任一失败时整体失败、保留缓存；这属于需要用户确认的可见失败语义。
- 每个请求仍需在发送前检查目标/凭据；若查询与推理在不同 origin，需单独决策安全边界，不能放开任意跨域。

## 用户授权与本地非敏感检查

- 最新用户边界：允许以刚创建的供应商尝试，但禁止主动读取或暴露真实 Key；此边界覆盖上一条仅禁止暴露的表述。
- 通过 SQLite `mode=ro` + `query_only=ON` 仅投影非敏感供应商字段和配置存在性布尔值；未查询 api_keys 表、token、secret 引用、request_headers 或 script 正文。
- release 数据库有 1 个匹配供应商，服务为 `https://api.commandcode.ai/provider`，账户查询脚本已配置，尚无余额/usage 缓存；dev 数据库没有匹配供应商。
- [management.rs:53–84](<crates/cc-use-daemon/src/management.rs#L53-L84>) 没有账户刷新路由；现有账户刷新为 Tauri IPC，不通过管理 HTTP 暴露。没有为了调研新增调试接口或读取管理 token。

## 公开客户端代码证据

- 来源为 npm 官方公开包 [command-code@1.88.4 metadata](https://registry.npmjs.org/command-code/latest) 与 [tarball](https://registry.npmjs.org/command-code/-/command-code-1.88.4.tgz)。只下载静态源码，未安装、执行 CLI 或读取任何本机 Command Code 配置。
- `fetchUsageCredits` 对应 `GET /alpha/billing/credits`，`fetchUsageSubscription` 对应 `GET /alpha/billing/subscriptions`；服务 origin 为 `https://api.commandcode.ai`，不是拼到 cc-use 推理 base 的 `/provider` 下面。
- `buildCommandApiHeaders` 使用 Bearer；具体账号有效性未使用用户凭据验证。
- `projectUsageView` 从 `credits.credits.monthlyCredits / purchasedCredits / freeCredits` 得到剩余额度，`credits.windowLimits.fiveHour / weekly` 包含 `used / cap / resetAt`；订阅返回 `data.planId / status / currentPeriodStart / currentPeriodEnd`。这些是代码推导的响应契约，未冒充真实账号返回。
- 最新客户端 credits 响应本身已经包含余额和 5h/weekly 窗口；subscription 是套餐/周期信息，不是为了取得窗口必须发的第二个请求。实际周期总消费需要另一条 `/alpha/usage/summary`，不能仅由剩余余额倒推出 used/total。
- CLI 完整 `/usage` 还先请求 `/alpha/whoami?limits=1`，用于 orgId，并再查询 summary；团队组织语义和完整周期消费不是默认双接口 MVP 可擅自承诺的范围。
- 无鉴权 GET 检查 credits/subscriptions 两个地址均返回 401；没有发送 Key、没有保留响应正文、没有计费推理调用。

## 用户确认的展示意图（2026-11-06 后续答复）

- 用户认为 Command Code 应与 OpenCode Go 同样呈现 5h／周／月三个限制窗口，区别最多是额外的换算余额；此答复替代先前将套餐到期作为独立展示目标的建议。
- [OpenCode Go extractor:95–131](<src-tauri/src/shared_runtime/account_scripts.rs#L95-L131>) 明确仅返回 rolling/weekly/monthly windows，不返回余额或货币单位；缺失百分比保持 null，不转为 0。
- [ProviderCard:184–219](<src/renderer/components/providers/ProviderCard.tsx#L184-L219>) 已能同时显示 windows 和独立余额；[ProviderUsageWindows:9–16](<src/renderer/components/providers/ProviderUsageWindows.tsx#L9-L16>) 明确不同周期不相加为钱。没有必要为 Command Code 增加一套订阅页面。
- Command Code `windowLimits` 没有独立 monthly 项，只有 fiveHour/weekly。月套餐剩余来自 monthlyCredits，月重置可条件使用有效的 `subscription.data.currentPeriodEnd`；不是 now+30天，也不是额外 credits 的失效时间。

## Command Code 月额度与单位核实

- 公开 `command-code@1.88.4` 客户端 `Ir` 为静态套餐月总额度表：individual-go/go-v1=10，individual-goat=70，individual-pro=30，individual-pro-v1=80，provider=15，individual-max=150，individual-ultra=300，teams-pro=40；不能将这份快照擅自升级为服务端长期契约。
- 设套餐月剩余 R=monthlyCredits，额外额度 E=purchasedCredits+freeCredits，静态套餐月总额 T。CLI `/usage` 的顶部比例使用 pool=max(T,R)+E、remaining=R+E，再计算 `(pool-remaining)/pool*100`；充值和 free 会稀释这个比例，不是纯月限制进度。
- 同包套餐耗尽提醒 `getCreditDepletionPct` 使用 `clamp((T-R)/T*100,0,100)`，排除 E。这才可能用作纯月套餐进度，但前提是活跃、已识别套餐且静态表单位/总量与当前套餐一致，R 为有效数字。
- [官方 Usage Limits](https://commandcode.ai/docs/resources/usage-limits) 称套餐 credits 为 usage-value units，不保证 1 credit=$1；GOAT 5h 14／周35 credits 对应最多$20／$50，Pro 5h16／周40 credits 对应最多$22／$55，且依模型有不同 allowance。虽然 CLI `formatCredits` 使用 `$` 前缀，内置模板不能因此直接标单位 USD 或按广告美元数反推总额度。
- 月度组织 spend limit 是另一套数据：whoami.orgLimits[].spent/limit/resetInterval/resetAt，不在 credits+subscriptions 两接口中。默认双接口模板不能冒充完整团队组织月限额查询。
- 结论：5h/weekly 可直接映射 `min(100,used/cap*100)`（要求有效 used 和正 cap），`resetAt` 为 API 毫秒时间戳，需要转换为标准 ISO 后传给当前窗口 UI，不能按秒处理；纯月百分比依赖静态套餐映射，有维护和准确性风险；未知套餐/月总额度不明时必须保持未知，不能制造 0%。余额应保留真实 credits 单位，除非另有可验证的货币换算契约。
- 交叉公开文档：[Pricing limits](https://commandcode.ai/docs/resources/pricing-limits)、[GOAT](https://commandcode.ai/docs/plans/goat)、[Pro](https://commandcode.ai/docs/plans/pro) 说明 billing cycle 刷新、topup 不过期与额外 credits 不享同样模型放大；按量账号没有套餐 rolling windows。月项宜描述为“套餐周期额度”，不能冒充与 5h/weekly 同构的 API window。
- 独立调研已结束：无本机用户数据/凭据访问、无账户接口请求、无产品文件修改，调研自身的临时源码已核验绝对路径后清理。

## 待产品决策

- 已确定复用周期额度展示、余额可选的范围；必要接口任一失败时整体失败保留缓存还是允许部分更新，仍待用户选择。
- Command Code 月窗口是否接受可编辑模板中明示的套餐总额快照及其未知降级语义，待最终设计评审；官方货币等价换算没有可靠通用公式，不可擅自承诺。

## OpenCode Go 剩余额度补充核查（用户追加）

- 用户追加希望核实 OpenCode Go 官方是否也有“剩余额度”展示；不能由 cc-use 现有模板的 omission 推断官方没有。
- [官方 Go / Usage beyond limits](https://opencode.ai/v2/docs/console/go/#usage-beyond-limits) 确认 Go 有 5h/weekly/monthly 套餐限制，Extra Usage 启用后触限可退回扣 Console credits 余额，Go Teams 默认启用；这是独立余额，不是从套餐剩余百分比换算的钱。
- [官方 Billing / Check your balance](https://opencode.ai/v2/docs/console/billing/#check-your-balance) 明确 billing drawer 同时显示 Go limits、credits 和 usage，credits余额仅 owners/admins 可见；不能假定普通推理 API Key 可直接查询管理账单数据。
- cc-use 当前 Go 模板只取各周期的 percent/reset/status：[account_scripts.rs:95–131](<src-tauri/src/shared_runtime/account_scripts.rs#L95-L131>)；[测试:443–474](<src-tauri/src/services/query_script.rs#L443-L474>) 的 metered fixture 明确 remaining=None，但这是本地标准映射，不是官方完整响应证据。
- [本地窗口 UI:45–70](<src/renderer/components/providers/ProviderUsageWindows.tsx#L45-L70>) 显示已用百分比及重置时间，没有单独显示 `100 - usedPercent` 的剩余百分比，更没有据此生成剩余金额。
- 旧公开 Go 实际路由为 `packages/console/app/src/routes/zen/go/v1/usage.ts`，不是猜测的 `/routes/go/v1/usage.ts`。固定 [revision d470434 / usage route](https://github.com/anomalyco/opencode/blob/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/console/app/src/routes/zen/go/v1/usage.ts) 中 `formatUsage` 主动简化成 `{usage:{rolling:{status,percent,resetsAt},weekly:{...},monthly:{...}}}`；没有 remaining/limit/used/unit/balance。现有模板兼容 camelCase resetsAt，没有漏掉这份已知响应的余额字段。
- 服务内部以 microcents 的 usage/limit 计算 `floor(min(100,usage/limit*100))`，但 API 只暴露取整百分比；`100 - percent` 只是近似剩余比例，没有额度上限时不能反推剩余金额。
- 初始 endpoint revision 2b8a5969e932c15083e599c82d34ce0268f81b9e 曾有 `useBalance` 布尔与 rollingUsage 等，也未返回钱包余额数值。较新 revision 9f8db119fcbd4999379129ac7734375ac23460fb 优先 proxyInference、否则保留旧形状；revision 03cb9b9946e0baa027d7678b690f8f352eb9a2bc 只剩 proxy，dev 后于 b9ca4d21b4f241154081143a6f5bef648f5ccfd0 删除 legacy 路由。公开旧契约与当前线上迁移后的响应必须区分，没有用用户凭据验证当前线上形状。
- 结论：官网确实有独立 Console 余额，但已知 Go usage API 不返回余额数值，不能判定是当前模板漏字段；若未来要显示 Console 钱包，应另查受权限约束的余额接口及凭据能力，不能与套餐窗口金额混用。本次用户追加仅授权核查，没有擅自扩展 Go 钱包实现范围。
- 仍只查公开代码/文档，不读取用户 Key，不对本地供应商发鉴权请求。

## 调研安全备注

公开 npm 源码自带遥测上传 token，第一次宽范围检索时该第三方内置值被工具输出带入当前会话和工具临时结果（非用户 Key）；随后仅使用脱敏可读副本并清理原始临时副本。用户真实凭据没有被读取或输出。会话工具历史需在会话管理中删除对应记录以清理，清理临时文件并不改写历史。

## 设计阶段独立复核补充（2026-11-06 晚，第二次核查）

对 `command-code@1.88.4`（仍是 npm latest）做了 count-only / bounded-context 抓取复核，全程只输出计数与切片、不包含任何源码原文逐段拷贝，临时目录即时删除，未触碰用户凭据。目的是把设计里要"写死进模板"的数值与公式落到一手事实：

- `resetAt` 确认为**epoch 毫秒数值**：`WindowLimitMeter` 直接以 `resetAt > now`（毫秒数字）比较并 `formatDuration(resetAt - now)` 倒计时；`Date.parse(resetAt)` 的另一处属于 whoami 组织限额的 ISO 字符串路径，不是窗口计时。上文 §Command Code 月额度与单位核实 的"毫秒、按秒处理会坏"结论成立。
- 客户端窗口百分比：`cap > 0 ? min(100, used/cap*100) : 0`；`used`/`cap`/`resetAt` 均在 windowLimits 的 fiveHour/weekly 子对象上。
- 余额合成：`totalRemaining = max(0,monthly) + max(0,purchased) + max(0,free)`；CLI 顶部用量百分比（`getUsagePercent({used, total})`，pool 含额外 credits）依赖 `/alpha/usage/summary`。
- 月耗尽口径复核：`getCreditDepletionPct` = `T = getPlanTotalCredits(planId)`，`T` 缺失或 ≤0 → null，否则 `clamp((T - monthlyCredits)/T*100, 0, 100)`；`getPlanTotalCredits` 是**精确 key 查表**（`Ir[planId] ?? null`），planId☾经 ToLower + `_`→`-` 归一化。设计选择归一化后精确匹配。
- 套餐月总额快照复核勘误：`Ir` 实际键为 `individual-provider: 15`（上文表格写的 `provider=15` 不是真实键）；其余键值与上文一致。
- 端点常量复核：`Dr="/alpha/whoami"`, `Nr="/alpha/billing/credits"`, `Fr="/alpha/billing/subscriptions"`, `_r="/alpha/usage/summary"`。
- credits 响应嵌套形态勘察：CLI 内无该响应构造 fixture；消费点 `e.credits?.credits`（amounts）与 `e.credits?.windowLimits`/`e.credits?.sandbox*` 以及耗尽警告路径的 `{…} = a.credits` 存在两种嵌套读法分歧。模板以防御式候选读取覆盖两种形态，最后不可读时 `isValid:false`。
- summary/订阅补充（终版设计依据）：`fetchUsageSummary` 总是传 `{orgId, since}`，但 `buildUsageEndpoint` 丢弃 null 参数，裸调 `/alpha/usage/summary` 形式可发；CLI 仅消费 `summary.totalCost`（当前周期已花费 credits 数）。订阅体形：`{ success?: bool, data: { planId, status, currentPeriodStart, currentPeriodEnd } }`。

## 用户拍板（2026-11-06 18:16，终版依据）

- 月度"已用/总额度"取自 `/alpha/usage/summary`（已用）与 `/alpha/billing/subscriptions`（套餐总额，按 planId 查映射），不用客户端静态快照作为唯一"总额"展示路径之外的构造；套餐映射仍以内嵌可编辑快照承接（设计 [design.md §1.4](./design.md)）。
- OpenCode Go 保持现状：不改模板、不显示余额、窗口展示不变；仅"从未刷新"的空状态可能新增占位（见设计 §4.6 的通用 loading 占位规则，不以 preset_id 分支）。
- Command Code 默认查询"三个限制 + 余额"，查到哪个展示哪个；没查到的项单独展示 loading 占位（查询已配置但无缓存/在途时逐块占位）。
- 由此 credits 为必需请求，subscriptions、summary 为可选请求；合计三条接口。
- 现有 Go 模板不返回余额一事另见上文 §OpenCode Go 剩余额度补充核查；本补充不改变其结论。
