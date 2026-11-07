# 统一网关 User-Agent 选择交互 技术设计

状态：轻量任务的候选设计；PRD 已收敛（见 [prd.md](<./prd.md>)），本文只补组件契约与改位点。
调研证据：[research 记录在 prd.md Background](<./prd.md>)；以下为设计落到代码的决策。

## 0. 决策摘要

| # | 决策 |
| --- | --- |
| D1 | `GatewayPage` 网关弹窗高级面板里的裸 `Input`（[GatewayPage.tsx:934–957](<src/renderer/pages/GatewayPage.tsx#L934-L957>)）替换为公共 `UserAgentField`（[UserAgentField.tsx](<src/renderer/components/UserAgentField.tsx>)），与密钥（[KeyEditModal.tsx:635–652](<src/renderer/components/keys/KeyEditModal.tsx#L635-L652>)）、模型清单（[ProviderModelModal.tsx:239–249](<src/renderer/components/providers/ProviderModelModal.tsx#L239-L249>)）同一交互 |
| D2 | `UserAgentField` 以**可选 prop 扩展**适配网关弹窗（不改密钥/模型清单路径）：新增 `inputId?: string`（让 `htmlFor='gateway-user-agent'` 关联）和 `invalid?: boolean`（CR/LF 校验时给 Input 红色边框/错误态）。两 prop 均缺省向后兼容 |
| D3 | 网关草稿语义保持现状：`onChange/onApply` 只写 `userAgent` 本地 state；`userAgent.trim() || null` 只在"保存"按钮 payload 中生效；取消/关闭弹窗不触发写 API。公共 UA 库的"保存/删除"是 `UserAgentField` 自身的显式动作，与网关提交天然解耦 |
| D4 | CR/LF 校验留在网关侧（`userAgentInvalid` 状态），Field 负责展示 invalid 态；错误文案/默认 UA 提示的既有 hint 结构不动 |
| D5 | UA 下拉数据源保持 `userAgentOptions(saved, …)`（[userAgentOptions.ts:8–24](<src/renderer/utils/userAgentOptions.ts#L8-L24>)），不复制一份"网关专用选项" |
| D6 | **（2026-11-06 用户修订）** 网关入口**只读**公共 UA 库：`UserAgentField` 新增可选 `libraryActions?: boolean`（默认 true 供密钥/模型清单），网关传 false 隐藏"保存到列表/从列表删除"两个动作；下拉仍可随意读取内置与本地分组。网关不该从会话配置弹窗里改共享库 |

## 1. 组件契约扩展（D2/D6）

```ts
interface Props {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onApply?: (value: string) => void
  disabled?: boolean
  inputId?: string      // 新增：透传给内部 <Input id={inputId}>
  invalid?: boolean     // 新增：透传给 <Input status={invalid ? 'error' : undefined}>
  libraryActions?: boolean  // 新增：默认 true；false 时本入口不提供保存/删除到公共库
}
```

- `aria-label='User-Agent'` 原样保留；`inputId` 提供后，`aria-label` 与显式 label 同时存在不冲突。
- 错误文案仍由调用方渲染（模型清单弹窗的既有做法 [ProviderModelModal.tsx:260–264](<src/renderer/components/providers/ProviderModelModal.tsx#L260-L264>)），Field 只负责控件级视觉状态。
- `onApply` 语义：下拉选中 / 失焦 / 回车时先 `onChange` 再 `onApply(next)`；网关场景 `onApply` 与 `onChange` 等价（草稿 state），校验延后到保存按钮（与 KeyEditModal 用法 [KeyEditModal.tsx:643–652](<src/renderer/components/keys/KeyEditModal.tsx#L643-L652>) 相同模式）。

## 2. 改位点与接线

`GatewayPage.tsx` 高级面板中的 UA 形式改动（其余字段不动）：

```tsx
<label htmlFor='gateway-user-agent' className={styles.fieldLabel}>{t('gateway.userAgent')}</label>
<UserAgentField
  value={userAgent}
  placeholder={t('gateway.userAgentPlaceholder')}
  onChange={(value) => {
    setFormError(null)
    setUserAgent(value)
  }}
  inputId='gateway-user-agent'
  invalid={userAgentInvalid}
  disabled={saving}
/>
<div className={userAgentInvalid ? styles.fieldError : styles.fieldHint}>
  {/* 原有三态 hint 原样保留 */}
</div>
```

要点：
- `providerUa` 默认值的提示文案（`gateway.userAgentDefault` / `userAgentNoDefault`）保留：网关留空 = 跟随供应商 request header 里的 UA（[GatewayPage.tsx:72–88, 471, 657–659](<src/renderer/pages/GatewayPage.tsx#L72-L88>) 的"follow"语义不变），下拉不清空该值时也只是草稿层面覆盖。
- 保存中控件禁用（`disabled={saving}`）覆盖 Input/下拉/保存 UA/删除 UA 按钮：`UserAgentField` 已透传 disabled。
- `UserAgentField` 挂载即拉取 UA 列表（[UserAgentField.tsx:23–36](<src/renderer/components/UserAgentField.tsx#L23-L36>)）——网关弹窗里位于 Collapse 条目，行为等同模型清单；公共 API 失败在 Field 内已有错误插条与不清空当前值（R4）。

## 3. 保存语义核对表（A3 对应）

| 动作 | 期望 |
| --- | --- |
| 选择 / 输入 UA | 只改 `userAgent` 草稿；`advancedSummary` 显示 `gateway.overridden`（现状逻辑 [GatewayPage.tsx:906–910](<src/renderer/pages/GatewayPage.tsx#L906-L910>)） |
| 点"保存" | `connection.userAgent = userAgent.trim() || null` 进 payload；`null` = 跟随供应商默认 |
| 取消 / 关闭 | 无写 API；下次打开从连接还原（现状 [GatewayPage.tsx:245–249](<src/renderer/pages/GatewayPage.tsx#L245-L249>)） |
| "保存 UA"（公共库） | 写公共 UA 列表，与网关提交互不影响 |
| "删除 UA" | 从列表移除该项；已输入框中的 UA 字符串不动 |
| 含 CR/LF | 输入框红色错误态 + 保存按钮被 `userAgentInvalid` 阻止（现状 [GatewayPage.tsx:283–286](<src/renderer/pages/GatewayPage.tsx#L283-L286>) 逻辑保留） |

## 4. 测试与验收

- 组件级（新增）：`UserAgentField` 接受 `inputId`/`invalid`，渲染 Id 关联与错误态；缺省时不回归。
- 页面级（[GatewayPage.test.tsx](<src/renderer/pages/GatewayPage.test.tsx>) 794 行，已有 UA follow/覆盖/保存断言，补齐）：打开网关弹窗切高级面板 → 下拉分组可见（内置/本地）→ 选择输入 → 保存 payload 断言（选择值、非法值被拦、清空保存为 null、取消无写 API）。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm format:check`。
- 后端不动：[user_agent.rs](<src-tauri/src/shared_runtime/user_agent.rs>) 的 validate/apply 契约（覆盖式 UA、留空不设）不需要变化 — 本任务是交互收敛，不是语义变更。
