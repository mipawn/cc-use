# 额度归属迁移：opencode / command code 改为密钥级

## Goal

1. 供应商列表（Keys 页）中，供应商摘要区的「查询额度」链接按钮删除——它调用的是与上方刷新图标完全相同的刷新命令，属于重复入口。
2. OpenCode Go 与 Command Code 的额度查询改为密钥级：这两个服务的额度查询本身就需要 API 密钥，一份密钥对应一个账号，多账号场景必须按密钥分别展示「剩余 / 5h / 周 / 月」额度；供应商级账户查询不再提供内置方案，历史账户级配置清空，供应商级查询入口隐藏。

## Background

- 当前内置查询方案目录分 account / key 两个 scope：OpenCode Go、Command Code 属于 account scope，仅 New API 有 key scope 方案（`/api/usage/token/`）。
- 供应商级查询会借用该供应商最低优先级的可用密钥发送，因此只有一个账号的结果；用户在 command code 下有多个账号密钥，账户级展示无法区分这些账号。
- 用户 2026-11-12 明确：删除供应商列表的「查询额度」按钮；OpenCode Go / Command Code 的额度放入密钥，包括剩余、月限、周限、5h 限；已有账户级配置只清空供应商级，不自动迁移到密钥；密钥卡片需要查询额度的手动入口；这两个供应商的供应商级账户查询区域隐藏。

## Requirements

- R1：Keys 页供应商摘要区不再出现「查询额度」链接按钮；刷新余额图标保留为供应商级账户查询的唯一手动入口。
- R2：OpenCode Go 与 Command Code 从 account 方案目录移除，改为 key 方案目录中的内置方案（脚本不变），密钥级方案支持展示计量窗口（5h / 周 / 月）。
- R3：密钥级查询结果保留窗口：密钥刷新与未保存草稿测试都返回 windows，不再按 account 专属字段剥离；密钥卡片展示该密钥自己的剩余额度与 5h / 周 / 月窗口。
- R4：密钥卡片额度条目恢复为可点击的查询/刷新入口（带进行中状态），用于手动重查该密钥额度；保存链路的自动刷新行为保留。
- R5：供应商新增 `queryScope`（account / key）持久化字段：新建时由预设决定（opencode-go、command-code 为 key，其余 account）；编辑不改变；导出/导入保持。
- R6：迁移：升级时把识别为 OpenCode Go / Command Code 账户查询的供应商标记为 key scope，并清空其账户级查询配置、旧版查询字段与账户级缓存；不自动向密钥复制配置。用户不需要重新填写供应商级配置，密钥额度由用户在每个密钥中显式选择内置方案后启用。
- R7：`queryScope = key` 的供应商不展示供应商级账户查询区域（编辑弹窗）与供应商级查询入口（配置查询按钮、刷新图标、账户余额/窗口展示），编辑弹窗给出「额度按密钥查询」的说明。
- R8：判定「账户级脚本」的密钥修复提示列表移除 Command Code 账户接口（它们现在是合法密钥级目标），New API / DeepSeek 账户接口仍提示。
- R9：既有关闭/方案/脚本保留、识别只按全文相等、不自造零值等既有查询规则不变。
- R10：zh / en 文案同步；不新增硬编码用户可见文案。

## Acceptance Criteria

- [ ] A1 / R1：Keys 页供应商摘要区不存在 `providers.queryNow` 链接按钮；已配置账户查询的供应商仍只有刷新图标作为手动触发。
- [ ] A2 / R2：`query_schemes` key scope 返回 OpenCode Go / Command Code 两个方案，account scope 不再返回；方案 capability 标明周期用量。
- [ ] A3 / R3：密钥刷新与 draft 测试对窗口型结果返回 windows；OpenCode Go 密钥卡展示 5h/周/月 三项，Command Code 密钥卡展示剩余 credits 与三项窗口。
- [ ] A4 / R4：密钥卡额度条目可点击查询，查询中显示加载态，失败提示不清空已有缓存。
- [ ] A5 / R5：Provider 契约新增 camelCase `queryScope`；新建 opencode/command code 预设供应商为 `key`，其他为 `account`；导出/导入保留。
- [ ] A6 / R6：升级迁移只清空供应商级账户查询相关列与缓存（脚本、query_config、旧版 type/url/headers、余额/用量缓存、检查时间），不触碰密钥既有脚本；再次启动不重复改数据。
- [ ] A7 / R7：key scope 供应商编辑弹窗隐藏账户查询区并显示说明；列表不显示配置查询/刷新余额入口与账户余额窗口。
- [ ] A8 / R8：Command Code 脚本在密钥编辑中不再触发「账户级脚本」修复提示；New API / DeepSeek 账户脚本仍提示。
- [ ] A9：`cargo fmt --check`、后端相关测试、`pnpm typecheck`、`pnpm lint`、相关 vitest 通过。

## Out of Scope

- 不新增供应商查询接口、不改变推理协议、模型管理、网关或客户端配置。
- 不把 OpenCode Go / Command Code 的账户级配置自动复制到密钥。
- 不重构通用查询编辑器；不改动 DeepSeek / New API 的账户级方案。
