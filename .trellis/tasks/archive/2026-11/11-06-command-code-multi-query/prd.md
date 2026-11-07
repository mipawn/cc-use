# Command Code 内置供应商与双接口查询

## Goal

用户选择内置 Command Code 模板后，一次账户刷新组合所需接口，沿用 OpenCode Go 的 5h／周／月额度窗口展示；Command Code 若返回可靠余额则额外显示余额，不另做订阅详情 UI。

## Background and Constraints

- 父任务：[Command Code 查询与网关 UA 交互完善](<.trellis/tasks/11-06-command-code-gateway-ua/prd.md>)；2026-11-06 已获立项授权，尚未获实施授权。
- 当前 request 只支持 GET，extractor 接收单个 JSON 响应：[query_script.rs:60–72](<src-tauri/src/services/query_script.rs#L60-L72>)、[query_script.rs:187–231](<src-tauri/src/services/query_script.rs#L187-L231>)。
- 执行器复用供应商代理 HTTP 客户端；缺少凭据和 URL 校验在发送前进行：[balance_service.rs:35–96](<src-tauri/src/services/balance_service.rs#L35-L96>)。
- 当前安全契约为 HTTPS 且与供应商同源：[query_script.rs:318–343](<src-tauri/src/services/query_script.rs#L318-L343>)。
- 保存前只做无凭据、无网络的脚本检查，失败刷新不覆盖缓存：[balance.rs:7–32](<src-tauri/src/commands/balance.rs#L7-L32>)、[balance.rs:54–71](<src-tauri/src/commands/balance.rs#L54-L71>)。
- 当前内置目录只有 custom、deepseek、newapi、opencode-go：[provider_presets.rs:257–265](<src-tauri/src/shared_runtime/provider_presets.rs#L257-L265>)。
- [Provider API 官方文档](https://commandcode.ai/docs/provider) 已确认推理服务入口为 `https://api.commandcode.ai/provider/v1`，支持 OpenAI/Anthropic 兼容接口与 Bearer；[Usage Limits 文档](https://commandcode.ai/docs/resources/usage-limits) 确认 CLI `/usage` 包含余额和 5h/weekly 窗口，但两篇文档均未公开账户查询 HTTP 契约。证据与候选方案见 [research.md](<.trellis/tasks/11-06-command-code-multi-query/research.md>)。

## Requirements

- R1：添加 Command Code 内置供应商模板，预填已验证的服务地址、必要连接默认值和可编辑账户查询脚本；不锁定后续配置，不自动改用户既有供应商。
- R2：查询脚本支持组合多个接口（2026-11-06 用户拍板：credits 必需 + subscriptions、summary 可选，共三条）。窗口映射：5h/weekly 来自 credits.windowLimits；月度"已用/总额度"来自 `/alpha/usage/summary`（已用）与 `/alpha/billing/subscriptions`（套餐总额，按 planId）；余额以 credits 数值返回（unit=credits）。缺哪项展示哪项，没查到的单独以 loading 占位呈现，不把窗口百分比合并成余额。声明格式与数据映射见 [design.md](<.trellis/tasks/11-06-command-code-multi-query/design.md>)。
- R3：现有 request + extractor(response) 脚本继续工作，无需改写、重新选择预设或数据迁移；余额与 Key 查询共用执行机制。
- R4：多接口场景仍进行凭据检查、目标校验与脚本沙箱限制，保存检查不发网络请求。
- R5：缺少必要数据不能显示为虚假的零余额或零使用量；失败行为需确定后形成可观测验收。
- R6：用户于 2026-11-06 允许以新建供应商为调研对象，同时明确禁止读取或暴露真实 Key。不得查询 key/token/secret 引用/鉴权头值，不导出数据库或读取认证文件；真实鉴权验证仅能由应用内部完成，不能另行提取密钥。

## Acceptance Criteria

- [ ] A1 / R1：内置模板列表显示 Command Code；选择后正确预填，保存/重开/导出导入不丢查询内容。
- [ ] A2 / R2：三条模拟接口完成一次账户刷新；5h／weekly 使用 credits 窗口数据，月窗由 summary + subscriptions 合成并与 OpenCode Go 一致地展示百分比和重置时间，同时可显示余额。缺少可靠月总额度时该项显示 loading/未返回而不虚构月窗百分比。缺项单独占位不混排。
- [ ] A3 / R3：已有单接口模板与自定义脚本原样通过，Key 额度查询无回归。
- [ ] A4 / R4：无凭据保存检查不联网；任意无效请求或越界目标被拒绝；缺失凭据不发送请求；沙箱限制仍生效。
- [ ] A5 / R5：失败/缺失字段不会伪造零值；缓存更新语义与确认的失败策略一致。
- [ ] A6：相关 Rust/前端测试、typecheck、lint、格式检查通过；中英文文案成对。

## Out of Scope

- 不新增 Command Code 本机客户端管理或启动配置，不增加自动模型映射或协议转换。
- 在接口证据确定前，不擅自添加 POST、任意跨域凭据发送、链式登录或 Cookie 存储能力。
- 不自动修改既有供应商/密钥、不接触用户真实凭据或发送真实计费调用。

## Open Questions

- ~~两个接口中任意一个失败时，是整体失败保留旧缓存，还是允许部分显示？~~ 已收敛为「必需请求整体失败 + 可选请求降级」混合语义（design.md D2/D3、§4）；仍待评审确认 optional 展开。

## Technical Notes Still Under Research

以下最初未决点已在设计与复核中收敛，实现以 [design.md](<.trellis/tasks/11-06-command-code-multi-query/design.md>) 为准：

- 公开客户端 credits 响应的嵌套形态两种读法并存（复核新增），模板以防御式候选读取 + 读不出即 `isValid:false` 处理；detail：[research.md §设计阶段独立复核补充](<.trellis/tasks/11-06-command-code-multi-query/research.md#设计阶段独立复核补充2026-11-06-晚第二次核查>)。
- 月窗口：不再"是否接受快照"二选一悬置——模板内嵌套餐总额快照并有未知降级语义（D6），评审门槛只针对是否接受该快照本身；快照数值勘误为 `individual-provider: 15`（research.md 复核节）。
- OpenCode Go 现有模板只返回 windows 没有货币余额，是官方 Go usage API 本身不带余额（见 research.md 补充核查），不是模板漏字段；cc-use 不为 Go 显示假余额。
- 周期与余额已有共同 UI（[ProviderCard:184–219](<src/renderer/components/providers/ProviderCard.tsx#L184-L219>)），本设计对 UI 组件零改动。
