# Command Code 双接口查询 技术设计

状态：**已获用户拍板（2026-11-06 18:16），可实施**。本版为终版设计。
调研证据：[research.md](<./research.md>)（官方文档 + 公开 npm 客户端 command-code@1.88.4 代码推导 + 本库代码证据；本设计对关键字段做过 count-only/bounded 独立复核）。

用户拍板记录：
1. 月度"已用/总额度"不用客户端快照做总额的唯一路径，取自 `/alpha/usage/summary`（已用）与 `/alpha/billing/subscriptions`（套餐/总额，按 planId）。
2. OpenCode Go 保持现状（不加余额、不改模板）。
3. Command Code 默认查询"三个限制 + 余额"，查到哪个展示哪个；没查到的项单独展示 loading 占位。

## 0. 决策摘要

| # | 决策 |
| --- | --- |
| D1 | 脚本引擎新增具名 `requests` 集合 + `extractor(responses)`；旧 `request`/`extractor(response)` 原样保留、二者互斥（[query_script.rs:187–231](<src-tauri/src/services/query_script.rs#L187-L231>) 现状单请求） |
| D2 | 必需请求任一失败（HTTP 非 2xx / 非 JSON / 凭据缺失 / 越界目标）→ 整次刷新失败，旧缓存不动（[balance.rs:54–71](<src-tauri/src/commands/balance.rs#L54-L71>) 现状"成功才写缓存"） |
| D3 | 请求可声明 `optional: true`：失败时以 `responses.<name> = null` 进入 extractor，不中止刷新。模板中**credits 必需；subscriptions、summary 均可选**——"查到哪个展示哪个" |
| D4 | 三条接口固定 GET + `Authorization: Bearer {{apiKey}}`，同 origin（api.commandcode.ai），满足现有同源契约（[query_script.rs:318–343](<src-tauri/src/services/query_script.rs#L318-L343>)） |
| D5 | 余额 = max(0,monthly)+max(0,purchased)+max(0,free) credits（绝不标 USD）；三个数值全缺时 `isValid:false`，不伪造 0 |
| D6 | 5h/weekly 窗口来自 credits.windowLimits（`used/cap/resetAt`，毫秒→ISO）；月窗"已用/总额度"来自 summary（`totalCost`）+ subscriptions（planId→套餐月总额快照，内嵌可编辑；若响应自带数值字段则以响应为准），`clamp(used/total×100)`，任一缺失 → percent 留空，不虚构 0% |
| D7 | 展示缺项用 loading 占位（本设计 §4.6）：查询已配置但该项还没有数据 → 单独显示加载占位；OpenCode Go 的数据展示不变 |
| D8 | 无 DB schema 变更、无迁移；`wallet_balance_script` 仍是文本列 |
| D9 | 不引入 whoami/组织限额；不做响应驱动的链式请求（summary 直接裸查，不带 `since`；若实测必需，后续扩展 chaining）；不新增 POST |

## 1. 响应契约（复核后的唯一事实源）

### 1.1 credits `GET /alpha/billing/credits`（必需）

- amounts：`body.credits`（或更内一层 `body.credits.credits`，双形态）；`monthlyCredits` / `purchasedCredits` / `freeCredits`；`credits.planId`（或内层）提供套餐 id。
- windowLimits：`body.credits.windowLimits` 或 `body.windowLimits`（客户端两种读法并存，模板防御式候选读取）：`fiveHour` / `weekly` 子对象含 `used`/`cap`/`resetAt`。
- `resetAt` = epoch 毫秒数值（客户端 `WindowLimitMeter` 直接 `resetAt > now` 数字比较）；cc-use 模板必须转 ISO 交给现有窗口 UI。
- 客户端窗口百分比 `cap>0 ? min(100,used/cap*100):0`；cc-use 改为 cap 无效 → `null`（"未返回"），不伪造 0%。

### 1.2 subscriptions `GET /alpha/billing/subscriptions`（可选）

- 体内形：`{ success?: bool, data: { planId, status, currentPeriodStart, currentPeriodEnd } }`。
- 用途：`planId`（经 `toLowerCase()+_→-` 归一化）查套餐月总额；`currentPeriodEnd` 作月窗 `resetsAt`；`status ∈ {active,trialing}` 才计算月窗百分比。
- 客户端精确查表 `getPlanTotalCredits(planId)`；无前缀匹配。

### 1.3 usage/summary `GET /alpha/usage/summary`（可选）

- CLI 仅消费 `summary.totalCost`（当前计费周期内已花费的 credits 数），作为月窗"已用"。
- CLI 总是带 `?orgId=&since=`；`buildUsageEndpoint` 丢弃 `null` 参数，因此裸调 `/alpha/usage/summary` 形式上可发。用户确认月度数据就在该接口；裸查失败（必要参数时）→ optional 降级为 loading 占位，不失败整刷。
- `totalCost` 为 credits 口径（客户端 `formatCredits` 只是渲染加 `$`）；不做货币换算。

### 1.4 套餐月总额快照（credits 单位；planId 精确匹配）

来自客户端 1.88.4 `Ir` 表（复核勘误：键为 `individual-provider`，不是 `provider`）：

| planId | 月总 credits | planId | 月总 credits |
| --- | --- | --- | --- |
| individual-go | 10 | individual-provider | 15 |
| individual-go-v1 | 10 | individual-max | 150 |
| individual-goat | 70 | individual-ultra | 300 |
| individual-pro | 30 | teams-pro | 40 |
| individual-pro-v1 | 80 | | |

实现联动：模板内嵌该表（可编辑）。若 subscriptions 响应将来自带套餐总额字段，实现时把该字段放在快照之前作为首选读取（防御式，键名按响应实际确认时再加）。未知 planId → 不给月窗百分比，比例一行保留 loading/未返回语义。

## 2. 内置供应商模板

`provider_presets.rs` 新增 `PRESET_COMMAND_CODE = "command-code"`：

| 字段 | 值 |
| --- | --- |
| default_name | `"command code"` |
| base_url | `https://api.commandcode.ai/provider`（官方推理入口 `/provider/v1`; cc-use 已有路径去重，[handler.rs:1744–1784](<src-tauri/src/proxy/handler.rs#L1744-L1784>) → claude/codex 路由均正确；用户现库同名供应商即此值） |
| icon | `claude`（无专属图，沿用 Go 做法，用户可改） |
| requires_site_address / needs_account_credential | false / false（账户查询用 `{{apiKey}}` Bearer） |
| wallet_balance_type | `"command-code"`；wallet_balance_url/headers 填 credits 端点与 Bearer 头（满足预设"带全请求"不变量） |
| usage_type / usage_url / usage_headers | `"none"` / None / None |
| request_adapter | `none` |
| default_key_config | types `[claude_code, codex]`；client_configs 两者 baseUrl = base_url、authScheme = `bearer`；model_mapping = None |

`wallet_balance_script`（三条请求；最终文本以实现为准，必须通过 `resolve_requests` 与 fixture 的 `run_extractor` 测试）：

```js
({
  requests: {
    credit: {                                     // 必需
      url: "https://api.commandcode.ai/alpha/billing/credits",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" }
    },
    subscription: {                               // 可选：查不到 → 月窗留 loading，不整刷失败
      url: "https://api.commandcode.ai/alpha/billing/subscriptions",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    },
    summary: {                                    // 可选：月度"已用"来源
      url: "https://api.commandcode.ai/alpha/usage/summary",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    }
  },
  extractor: function (responses) {
    // 套餐月总额（credits 单位），按 subscriptions 返回的 planId 精确查表；
    // 这是客户端 1.88.4 的快照，套餐新增/改名需要手动改这里。
    var planTotal = { "individual-go":10, "individual-go-v1":10, "individual-goat":70,
      "individual-pro":30, "individual-pro-v1":80, "individual-provider":15,
      "individual-max":150, "individual-ultra":300, "teams-pro":40 }

    var num = function (value) {
      if (value == null) return null
      var n = Number(value)
      return isFinite(n) ? n : null
    }
    var msToIso = function (value) {
      var ms = num(value)
      if (ms == null) return null
      var date = new Date(ms)
      return isNaN(date.getTime()) ? null : date.toISOString()
    }
    var anyIso = function (value) {           // resetAt 可能是毫秒数字或可解析时间串
      var ms = num(value)
      if (ms != null) {
        var date = new Date(ms)
        return isNaN(date.getTime()) ? null : date.toISOString()
      }
      if (value == null) return null
      var parsed = new Date(String(value))
      return isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
    // credits 块：客户端存在两种嵌套读法（research.md 复核节）
    var top = function (body) {
      if (body == null || typeof body !== "object") return null
      var outer = body.credits
      if (outer == null || typeof outer !== "object") return null
      var amounts = outer.credits != null && typeof outer.credits === "object" ? outer.credits : outer
      var limits = outer.windowLimits != null && typeof outer.windowLimits === "object"
        ? outer.windowLimits
        : (amounts.windowLimits != null && typeof amounts.windowLimits === "object"
          ? amounts.windowLimits
          : null)
      return { amounts: amounts, limits: limits,
        planId: (outer.planId != null ? outer.planId : (amounts.planId != null ? amounts.planId : null)) }
    }
    var credits = top(responses.credit)
    if (credits == null) return { isValid: false, invalidMessage: "响应里没有可读的 credits 对象" }
    var monthly = num(credits.amounts.monthlyCredits)
    var purchased = num(credits.amounts.purchasedCredits)
    var free = num(credits.amounts.freeCredits)
    // 三个数值全缺＝接口正常但没报余额，不得汇总成 0（真实 0 剩余会是具体数字）
    if (monthly == null && purchased == null && free == null) {
      return { isValid: false, invalidMessage: "credits 数值缺失" }
    }
    var usage = {
      remaining: (monthly != null && monthly > 0 ? monthly : 0)
        + (purchased != null && purchased > 0 ? purchased : 0)
        + (free != null && free > 0 ? free : 0),
      unit: "credits"   // usage-value units；不做 $ 换算、不标 USD
    }
    var windows = []
    var push = function (id, limit) {
      if (limit == null || typeof limit !== "object") return
      var cap = num(limit.cap)
      var used = num(limit.used)
      windows.push({
        id: id,                                   // rolling/weekly/monthly：UI 字典给文案与排序
        usedPercent: cap != null && cap > 0 && used != null
          ? Math.min(100, used / cap * 100)
          : null,                                 // cap 缺失/≤0 → 未返回
        resetsAt: msToIso(limit.resetAt)          // 毫秒 → ISO 落到 UI 既有倒计时
      })
    }
    push("rolling", credits.limits != null ? credits.limits.fiveHour : null)
    push("weekly", credits.limits != null ? credits.limits.weekly : null)

    // 月窗："已用"来自 summary.totalCost，"总额度"来自 subscription.planId → planTotal；
    // 两者任一缺失 → 百分比留空（loading/未返回），不虚构。
    var subResp = responses.subscription
    var sumResp = responses.summary
    var sub = subResp != null && subResp.data != null && typeof subResp.data === "object" ? subResp.data : null
    var sum = sumResp != null && typeof sumResp === "object" ? sumResp : null
    if (sub != null) {
      var rawPlanId = sub.planId != null ? sub.planId : credits.planId
      var planKey = rawPlanId != null ? String(rawPlanId).toLowerCase().replace(/_/g, "-") : null
      var total = planKey != null ? planTotal[planKey] : null    // 精确匹配；未知 → null
      var used = sum != null ? num(sum.totalCost) : null
      var periodEnd = sub.currentPeriodEnd != null ? anyIso(sub.currentPeriodEnd) : null
      var percent = total != null && total > 0 && used != null && used >= 0
        && (sub.status == null || sub.status === "active" || sub.status === "trialing")
        ? Math.min(100, Math.max(0, used / total * 100))
        : null
      windows.push({ id: "monthly", usedPercent: percent, resetsAt: periodEnd })
    }
    usage.windows = windows
    return usage
  }
})
```

模板语义要点：
- credits 块不可读 / 三个数值全缺 → `isValid:false`（不显示假零）。
- credits 成功但 subscription/summary 缺失 → 余额 + 5h/周窗照常展示；月窗行不产生（UI 通过 §4.6 占位表达"另在上 loading/待查询"）。
- 按量（无套餐）账号：无 windowLimits → 窗口行留空占位；余额照常；月窗不虚构。
- 真实 0 剩余（数字 0）照常显示 0 balance；只有"数值缺"才走 isValid:false。

## 3. 脚本引擎扩展

### 3.1 解析（query_script.rs）

```rust
#[derive(Serialize, Deserialize)]
pub struct NamedRequest {
    #[serde(flatten)]
    pub request: ScriptRequest,       // url/method/headers 复用
    #[serde(default)]
    pub optional: bool,
}
pub enum ResolvedRequests {
    Single(ScriptRequest),            // 旧契约：行为逐字节一致
    Many(BTreeMap<String, NamedRequest>),
}
pub fn resolve_requests(script, vars, limits) -> Result<ResolvedRequests, QueryScriptError>
```

校验：`request` 与 `requests` 同现 → "request 与 requests 二选一"；两者皆无 → 现状错误；名称非空、url 非空、仅 GET。

### 3.2 extractor 调用

- 新契约把各响应（optional 失败 → null）组装对象传入 `extractor(responses)`；一次 `evaluate()`、同一沙箱上限；`AccountUsage`（deny_unknown_fields）解析、label 补全、空结果防线复用。

### 3.3 执行（balance_service.rs）

- `run()`：Single → 现状路径；Many → 逐请求 `ensure_query_credentials` + `is_permitted_target`，全部通过后并发发送（`futures::future::join_all`；如实现不便可顺序 await，语义不变）。
- 必需失败 → 返回错误（整体失败留缓存）；可选失败 → null 占位进入 extractor。
- 聚合器抽成纯函数便于离线测试；发送函数可注入假 future 避免真实网络。
- envelope/缓存写入零改动；`cached_wallet_balance` 接 credits 数值、货币列存 `credits`；卡片渲染 `12.34 credits`（[ProviderCard.tsx:202–219](<src/renderer/components/providers/ProviderCard.tsx#L202-L219>) 已支持未知单位后缀）。

### 3.4 保存检查（commands/balance.rs）

- `provider_script_check` 改用 `resolve_requests`：Single → 现状 `{url,method,headers}`；Many → `{requests:{name:{url,method,headers,optional}}}`。ProviderModal 只拿它当 pass/fail（[ProviderModal.tsx:170–181](<src/renderer/components/providers/ProviderModal.tsx#L170-L181>)），无 UI 变更。
- Key 额度查询（usage_service）走同一 `run()`，多请求能力自动可用、无回归要求。

## 4. 失败语义与可观测

| 场景 | 行为 | 用户可见 |
| --- | --- | --- |
| credits 非 2xx / 非 JSON / 凭据缺失 / 越界 | 整刷失败，旧缓存不动 | 卡片刷新报错 toast；原数据保留 |
| credits 可达但不可读 / 数值全缺 | isValid:false → 不写缓存 | invalidMessage 文案 |
| subscription / summary 失败或缺失（optional） | 该名字 = null → 月窗百分比留空或月窗行不产生 | 月窗/对应项按 §4.6 展示 loading/未返回；不弹错 |
| cap 缺失/≤0、resetAt 缺失 | 窗口行percent"未返回"，无重置行 | 既有 UI 支持（[ProviderUsageWindows.tsx:45–72](<src/renderer/components/providers/ProviderUsageWindows.tsx#L45-L72>)） |

### 4.6 缺项 loading 占位（用户拍板 D7）

规则（通用、数据驱动，不基于 preset_id 分支——[provider_presets.rs:4–8](<src-tauri/src/shared_runtime/provider_presets.rs>) 明令禁止从 preset_id 反推行为）：

- provider 配置了账户查询脚本（`hasProviderQuery`）但该数据块没有缓存（从未查过）或本次刷新仍在途 → 该数据块**单独**显示 loading 占位（小加载图标 + "查询中…"文案），其余已查到的块照常显示（货不走全局 spinner）。
- 查询完成（lastCheckedAt 已有）后，数据真正缺失的窗口行显示"未返回"（诚实终态，与 Go 一致）；余额缺失时余额块继续保留 loading 占位（因为 Command Code 模板的查询必含余额，缺余额意味着查询出错，错误已由 toast 报告，占位防止"看起来没这项"）。
- OpenCode Go 受影响面：仅在"从未刷新过"的空状态多出占位块；已查过的 Go 卡片展示与今天逐字节一致。

## 5. 兼容与安全

- 既有单请求/预设脚本不迁移不重写（R3/A3）；`provider_presets.rs` 明令禁止从 preset_id 反推行为 -> loading 占位用"查询已配置 + 无缓存/在途"的数据驱动条件。
- 导入导出按文本过 `provider_script_check`，合法即存。
- 沙箱、凭据检查、HTTPS + 同源不变；多请求逐请求校验。
- 不读取/不输出真实凭据；测试全部离线 fixture。

## 6. 验证口径

- Rust：单/多/互斥/optional 解析、双形态 credits fixture、月窗 summary×subscriptions 合成（毫秒/字符串时间、未知套餐、status gate）、防假 0、必需失败中止、可选失败注入、DTO 双形态、presets 断言（base_url、三端点、optional 标记、unit credits、bearer defaults）。
- 前端：ProviderCard 加载占位（有/无缓存 × 刷新在途 × 未查过）、既有用例回归（含 Go 卡片快照不变）；typecheck/lint/vitest/prettier。
- 无真实鉴权调用：全部 fixture 驱动；真实校验由用户首次刷新完成。
