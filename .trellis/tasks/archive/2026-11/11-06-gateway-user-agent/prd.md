# 统一网关 User-Agent 选择交互

## Goal

网关创建/编辑时，User-Agent 与密钥编辑、供应商模型清单采用同一套输入、下拉选择和自定义管理交互。

## Background and Constraints

- 父任务：[Command Code 查询与网关 UA 交互完善](<.trellis/tasks/11-06-command-code-gateway-ua/prd.md>)；2026-11-06 用户确认按已描述的范围立项，尚未获实施授权。
- 网关当前为普通 Input，没有 UA 下拉：[GatewayPage.tsx:934–957](<src/renderer/pages/GatewayPage.tsx#L934-L957>)。
- 公共组件已经包含输入/清空、内置与本地 UA 分组下拉、自定义保存/删除和异步错误状态：[UserAgentField.tsx:16–129](<src/renderer/components/UserAgentField.tsx#L16-L129>)。
- 密钥和模型清单已有公共组件调用：[KeyEditModal.tsx:635–652](<src/renderer/components/keys/KeyEditModal.tsx#L635-L652>)、[ProviderModelModal.tsx:239–249](<src/renderer/components/providers/ProviderModelModal.tsx#L239-L249>)。
- UA 选项源：[userAgentOptions.ts:1–24](<src/renderer/utils/userAgentOptions.ts#L1-L24>)；不复制一份网关专用选项。

## Requirements

- R1：网关高级设置复用 UserAgentField，提供与其他入口相同的内置/本地 UA 下拉、手工输入、清空；**（2026-11-06 用户修订）网关只读公共 UA 库——不再提供"保存到列表/从列表删除"动作，公共库写入与删除仅由密钥/模型清单入口承载**。
- R2：选择/输入只修改网关草稿；网关显式保存才更新转发配置，取消不保存网关草稿。自定义 UA 的库操作不在网关入口出现，不与网关提交混淆。
- R3：留空保持原有不覆盖规则；不继承内置客户端 UA、不更改供应商/密钥的 UA 配置。
- R4：保留 CR/LF 校验、默认 UA/无默认提示；网关保存中禁用相关 UA 交互，公共 UA API 失败可见且不清空当前值。
- R5：保留可访问标签与适配窄窗口的布局；如公共组件需要额外 Input id/status prop，以可选 prop 扩展，不改变其他入口行为（新增 `libraryActions` 时默认值须保持其他入口现状）。

## Acceptance Criteria

- [ ] A1 / R1：网关创建/编辑均可打开下拉，内置及本地选项与其他入口一致；选中后输入框显示该值；**网关内无"保存到列表/从列表删除"按钮，公共库只能被读取**。
- [ ] A2 / R1：自定义 UA 可保存至公共库、其他入口随后可见、可删除——该能力的入口是密钥/模型清单，不在网关弹窗内。
- [ ] A3 / R2–R3：网关保存 payload 为选中/输入值；清空保存为 null；取消不调用网关写 API，不改其他配置、不动公共 UA 库。
- [ ] A4 / R4：非法换行仍阻止保存并显示错误；保存中控件禁用；公共 UA API 失败有可见反馈。
- [ ] A5 / R5：标签关联正确，窄窗口/明暗主题正常，GatewayPage 和 UserAgentField 相关测试及前端门禁通过（含 `libraryActions` 默认不受影响的回归）。

## Out of Scope

- 不修改 Rust/数据库/网关连接优先级、认证方式、模型暴露规则或 UA 内置预设内容。
- 不新增网络 UA 查询、第二套 UA 管理库或全站样式重构。

## Artifact Status

这是可 PRD-only 的独立轻量任务；需求已收敛，最终规划摘要确认后才激活实施。与查询子任务无业务依赖。技术设计已补齐：[design.md](<.trellis/tasks/11-06-gateway-user-agent/design.md>)（UserAgentField 可选 prop 扩展 + 网关改位点 + 保存语义核对表）。
