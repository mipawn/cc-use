# Command Code 双接口查询 执行计划

状态：**用户已拍板（2026-11-06 18:16），授权实施**。设计终版：[design.md](<./design.md>)；调研：[research.md](<./research.md>)。开工前先读 `.trellis/spec/cc-use/backend/index.md` / `frontend/index.md` 相关分册。
并行拆分：Steps 1–4（全部 Rust）由后端实施者承担；Step 5（前端 loading 占位）由前端实施者承担；Step 6 门禁由 Lead 汇总执行。

## 步序与范围

### Step 1 — 引擎层：多请求契约（`src-tauri/src/services/query_script.rs`，后端）

- [ ] 新增 `NamedRequest`（`#[serde(flatten)] request: ScriptRequest` + `optional: bool`）与 `ResolvedRequests::{Single, Many}`。
- [ ] 新增 `resolve_requests()`：走同一 `substitute()`；校验（request/requests 互斥、名称非空、url 非空、仅 GET）；旧 `request` 分支行为不变。
- [ ] `run_extractor` 增加多响应变体：各响应（optional 失败 → null）组装为对象嵌入；单次 `evaluate()`、同一 `ScriptLimits`；`AccountUsage` 解析、label 补全、空结果防线复用。
- [ ] 离线测试：
  - 现有全部旧契约用例原样通过（兼容 A3）。
  - design.md §2 终版模板脚本作为 fixture：credits 两种嵌套形态 → 余额/5h/weekly 数值断言、毫秒→ISO 断言、cap≤0 → null 断言。
  - 月窗合成：summary.totalCost × planTotal 精确匹配 → `clamp(used/total×100)` 断言；summary 缺失 / 未知 planId / status 非 active+trialing → percent null；currentPeriodEnd 毫秒与字符串两种入参 → ISO。
  - 三值全缺 → isValid:false"credits 数值缺失"；防假 0。
  - optional 注入 null；占位符缺失报错文案不变；互斥与空缺报错。
- [ ] `cargo test --workspace` 全绿再进下一步（回滚点 R1）。

### Step 2 — 执行层：多请求发送（`src-tauri/src/services/balance_service.rs`，后端）

- [ ] `run()` 改用 `resolve_requests()`：Single 走现状路径；Many 逐请求过 `ensure_query_credentials` + `is_permitted_target`，通过后并发（或顺序）发送。
- [ ] 聚合器抽成纯函数（输入：named requests + 每个 future 的 Result → 输出：Err（首个必需失败文案）或 responses map）；`send()` 提取为可注入签名以便离线测试。
- [ ] 测试：必需失败 → 整体 Err；可选失败 → None 占位；required/optional 混合（design.md §4 表格的引擎侧断言）。
- [ ] `cargo test --workspace` 全绿（回滚点 R2）。

### Step 3 — 命令层 DTO（`src-tauri/src/commands/balance.rs`，后端）

- [ ] `provider_script_check` 改用 `resolve_requests`；Single 输出 `{url,method,headers}` 不变；Many 输出 `{requests:{name:{url,method,headers,optional}}}`。
- [ ] 单测：两形态 JSON 断言；保存检查不联网基线保持。
- [ ] `cargo test --workspace` 全绿（回滚点 R3）。

### Step 4 — 模板与目录（`src-tauri/src/shared_runtime/`，后端）

- [ ] `account_scripts.rs`：新增 Command Code 脚本（与 design.md §2 终版文本一致；建议新增 `compose_multi` helper 或等价 const 组装）。
- [ ] `provider_presets.rs`：新增 `command_code_preset()`（字段值见 design.md §2）；catalogue 顺序 `custom, deepseek, newapi, opencode-go, command-code`。
- [ ] 测试：既有 preset 不变量不动即成立（command-code 的 type 非 none/custom，触发"带全请求"断言）；新增 command-code 断言：base_url、三条端点均在脚本中、credit 无 optional、subscription/summary 带 `optional: true`、`unit: "credits"`、`{{apiKey}}`、key defaults bearer。
- [ ] `cargo test --workspace` 全绿（回滚点 R4）。

### Step 5 — 前端：缺项 loading 占位（`src/renderer/…`，前端实施者）

- [ ] `ProviderCard.tsx`：数据驱动占位——`hasProviderQuery(provider)` 且（`refreshing` 或从未成功查过）且对应块无缓存 → 单独 loading 占位（加载图标 + "查询中…"）：
  - 用量块：`windows.length === 0` 且上述条件 → 块内一行占位（复用 ProviderUsageWindows 的样式语言）。
  - 余额块：amount 为 null 且上述条件 → 余额行占位。
- [ ] 查询完成后：真实值照常；窗口缺 percent → "未返回"（既有终态）；OpenCode Go 已查过的卡片展示与现在逐字节一致（回归快照）。
- [ ] locale：`providers.usagePending`（zh"查询中…"/en"Checking…"）成对新增；确认余额占位文案复用或新增成对键。
- [ ] 组件测试：占位出现/消失矩阵（无脚本、有脚本未查、查过无数据、刷新在途、已有缓存刷新在途）。
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` 相关文件全绿。

### Step 6 — 质量门禁（Lead 汇总）

- [ ] `pnpm test:all`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check` 全部通过。
- [ ] 手测（不发送真实请求）：模板预填、保存检查 pass、显示占位真实不联网。
- [ ] 收尾按 Trellis Phase 3：spec 更新（learnings）→ commit。

## 回滚点

| 点 | 内容 | 回滚方式 |
| --- | --- | --- |
| R1–R4 | 每步 cargo 全绿后再进下一步 | 多请求能力集中在 query_script/balance_service/模板常量；git revert 恢复单请求引擎 |
| 前端 | Step 5 独立提交位 | 占位 UI 单文件可回退，不影响引擎 |

## 验收对应表（PRD A1–A6）

| 验收 | 证据 |
| --- | --- |
| A1 模板预填/不丢失 | Step 4 preset 测试 + ProviderModal 既有用例 |
| A2 三接口一次刷新、5h/weekly 月窗合成、余额、缺项占位 | Step 1 fixture 断言 + Step 5 占位测试 |
| A3 旧脚本/Key 查询无回归、Go 现状 | Step 1 旧用例 + Step 5 Go 快照断言 |
| A4 逐请求凭据/目标校验、保存不联网 | Step 1/2 校验测试 + Step 3 不联网基线 |
| A5 失败语义、缺失不伪造零 | Step 1 防假 0 断言 + Step 2 聚合器断言 |
| A6 门禁全绿 | Step 6 命令清单 |
