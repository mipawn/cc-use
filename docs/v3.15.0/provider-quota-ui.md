# 供应商额度 UI

日期：2026-10-26

## 问题

- 额度区块 `.providerQuota` 顶部内边距为 0，5h 额度直接贴在供应商 header 的下边框上。
- 进度条与重置/状态行之间没有间距，读起来是一整块。
- 无缓存时的查询按钮是额度区里的裸默认按钮：左对齐、无图标、无层级，且与 header 右侧的刷新图标重复。

## 改动

- `.providerQuota` 内边距改为 `14px 16px`，窄容器规则同步检查。
- `ProviderUsageWindows` 的重置行增加 `margin-top: 4px`。
- 移除额度区里的裸按钮；空状态使用与 header 一致的 `type='link'` + 刷新图标 + `providers.queryNow` 文案，右对齐。
- 有数据时仍使用 header 的刷新图标，不出现两个同权重的查询入口。

## 验收

- 1024 / 1280 / 1440 宽度下，5h 区块与 header 有稳定间距。
- 查询动作与所在区域对齐，不悬空、不重复。
- 查询链路不变：`handleRefreshBalance → providerStore.refreshBalance → balance_refresh`。
