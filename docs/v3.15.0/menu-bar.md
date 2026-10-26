# 仅菜单栏常驻

日期：2026-10-26

## 行为

- macOS 上应用只保留顶部菜单栏状态项，不再显示 Dock 图标，也不出现在 Cmd+Tab。
- 关闭窗口始终隐藏，不销毁窗口；从顶部菜单栏菜单重新打开。
- 运行中双击 Finder / Spotlight 中的应用图标会触发 `RunEvent::Reopen`，同样只是显示并聚焦窗口。
- 退出使用菜单栏菜单的退出项。

## 实现

- `src-tauri/Info.plist` 设置 `LSUIElement=true`，覆盖打包后的冷启动。
- `lib.rs` setup 早期调用 `ActivationPolicy::Accessory`，覆盖运行期显示窗口时的激活策略。
- 所有 `set_dock_visibility` 调用已移除；显示/隐藏只操作窗口本身。
- `tray::show_main_window` 统一 `show + unminimize + set_focus + 刷新菜单`。
- `CloseRequested` 一律 `prevent_close() + hide()`，不再依赖 `closeToTray` 的 false 分支。
- 设置页的“关闭到托盘”开关改为固定开启并禁用，文案说明菜单栏常驻行为。

## 已知边界

- Cmd+Tab 不再出现，这是 Accessory 模式的预期行为。
- 窗口生命周期没有自动化测试，需要 macOS 手工验收：无 Dock、菜单栏存在、关闭后菜单栏可打开、Finder/Spotlight 可重开、托盘退出可用。
