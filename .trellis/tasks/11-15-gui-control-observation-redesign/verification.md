# 完整改版验收记录

## 2026-11-16 提交前复核

- 用户明确批准完整 GUI 改版与按钮修正合并提交，随后归档并记录日志；此授权替代此前的“不自动提交/归档”限制，不包括 push、tag 或发布。
- “添加密钥”统一为横向紧凑虚线按钮，移除依赖密钥数量奇偶的布局分支与旧 Card 样式；保留原添加逻辑、主题色、键盘焦点和 reduced-motion。
- 本轮重新运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`（54 个文件/543 项 Vitest + 12 项脚本测试）、`pnpm build:frontend`、`cargo fmt --all -- --check`、`cargo test --workspace`、`git diff --check`，全部 exit 0。按钮相关文件 Prettier 检查及 antd lint 通过。
- 本轮未重新运行浏览器视觉验收；下文浏览器证据属于 11-15 完整改版验收。测试仍有既有 jsdom/antd 弃用及 Vite chunk 提示，不影响通过。
- 待提交路径清单与此前完整改版一致；提交前再次执行 `git diff --check` 通过。独立复核子代理启动后失败，无复核结论，不作为通过证据。


日期：2026-11-15。工作分支：`gui-control-observation-redesign`。实现范围和授权见 [PRD](./prd.md)。

## 交付边界

- GUI 负责资源配置、运行控制、桌面接入和观测；客户端由 `cc-use` CLI 启动。
- 保留年度热力图和今日统计；移除 GUI/托盘项目启动入口，但保留项目数据、共享 API、CLI 默认绑定与前置命令。
- Desktop 只陈述配置和操作事实；不把请求、进程或关闭提示当作已重新载入的证据。
- 统计是持久化账本，控制台是有限留存流；精确定位不受全局 500 条缓冲限制。

## 自动化质量门

最终冻结代码质量门通过（2026-11-15，所有产品与 fixture 修正之后）：

- `pnpm typecheck`、`pnpm lint`：通过，零错误/警告。
- `pnpm test`：**54 个 Vitest 文件、543 项测试**通过；另 6 项发布说明测试与 6 项构建脚本测试通过。
- `pnpm build:frontend`：生产前端构建成功；`cargo fmt --all -- --check`、`git diff --check` 通过。
- `cargo test --workspace`：完整 workspace 测试通过；此后未改 Rust 代码。
- 本地日期/时间选择器已在 Asia/Shanghai、America/Los_Angeles 下验证；Desktop fixture 的 RFC3339 操作时间与固定时钟也在这两个时区通过回归。

详细输出：[最终前端集成门](/tmp/cc-use-final-acceptance-gate.log)、[完整 Rust workspace 门](/tmp/cc-use-rust-final-gate.log)。隔离浏览器 TaskSpace 和自建预览终端已关闭。

## 已验证的浏览器旅程

浏览器仅连接独立 Vite DEV fixture。TaskSpace 7 / p1；未连接真实 daemon、Keychain、供应商或客户端配置。fixture 未实现方法一律拒绝，不回退原生 API。

| 旅程 | 已确认结果 |
| --- | --- |
| 今日失败 → 请求账本 | 本地日期范围正确；8 个失败请求，包含零 Token 失败；`outcome=failed&population=all`，没有扩大来源范围 |
| 请求详情 → 控制台 → 原账本 | URL 保留日期、范围、页码和 requestId；无留存时明确提示；`request-1` 可命中全局 500 条之外的留存事件 |
| 混合运行实例 → 换线 | 7 个活跃、105 个结束实例；同目录多实例、stale 状态和真实客户端区分；刷新后搜索和所选密钥保留；确认后只更新所选行 |
| 空资源 → 新供应商 → 新密钥 → 原 Desktop 操作 | 新建后自动返回选中，但仍是官方状态；显式应用后才接入；供应商/密钥名称即时显示，不出现“资源不可用” |
| Desktop 配置预览与恢复 | 只读脱敏预览；Escape 返回原按钮焦点；恢复有确认，结果保留重新打开客户端说明 |
| Desktop 部分成功 | 真实范围和已变更线路可见；选择器在错误处理结束后仍打开、选择保留；Enter 可选择密钥，Escape 可退出；user/startup 不误称密钥已保存 |
| Desktop 读取失败与重试 | 显示 unknown 而非官方；重试确实再次读取，持续错误仍保留 unknown |
| Desktop 纯换线 → 离开并返回 | 原配置写入说明逐字保留；换线不冒充重新写配置，重新进入页面仍读取同一记录 |
| Gateway 选线 → 草稿 → 保存 → 重开编辑 | 选线后尚无 gateway.update 调用；显式保存恰好一次；两项模型限制和 legacy-missing-model 原样保留，绑定更新为新资源 |
| 已有 Key 编辑 → 保存 → Desktop 同步失败 | 表单可正常打开；只改别名即保存成功、关闭弹窗，单独显示同步失败警告；进入 Desktop 后新名称和 key_edit 失败事实仍可见 |
| 已有 Key 更新合成凭证 → 保存 → 额度查询失败 | 显式更改测试凭证触发恰好一次异步查询；保存成功，查询失败单独提示，旧 $71.75 缓存保留。仅改别名不触发查询是正确优化，不强行要求刷新 |

## 视觉与键盘

概览完成 **zh/en × light/dark × 1440×1000/900×700** 共 8 组真实截图。全部检查 `documentElement.scrollWidth <= innerWidth`，主内容无横向溢出，fixture violations 为空。900px 保留热力图、三项今日指标和完整主导航。

另检查：900px Desktop、1440px 选线器、长供应商名、账号 CNY 多窗口、密钥 USD 额度、Token 单位、未知额度与耗尽 0 的区别、禁用资源、空资源、错误和 partial 状态。配置预览 Escape 焦点返回、选线键盘 Enter/Escape 已验证；`prefers-reduced-motion` 媒体条件已验证，相关 CSS 遵守该条件。

900×700 选线器专项：正常/partial footer 均处于 y=628–664，空态 footer 处于约 y=549–585，全部在视口内且无横向溢出。partial 保留选择和可重试按钮；以导航前固定的 reduced-motion 条件重测。最终 [紧凑选线截图](/tmp/cc-use-qa-20261115/picker-en-dark-900.png) 与 [部分成功截图](/tmp/cc-use-qa-20261115/desktop-partial-en-dark-900.png) 已人工读取核验。

截图目录：`/tmp/cc-use-qa-20261115/`。截图均为合成数据，不是原生接管成功证据。

## 验收中发现并修正的问题

1. 自定义日期 URL 未正确反映在时间选择器、all 被显示为 week：受控日期和明确 all 标签修正；覆盖外部变化、本地日期、跨日及 23/25 小时 DST 日。
2. 切换客户端后旧实例操作迟到：按客户端视图生命周期隔离异步结果，避免覆盖新列表或释放新操作锁。
3. Desktop 就地新建资源应用后摘要缺失：把已选资源并入本地展示状态。
4. Desktop 一般同步失败误称“密钥已保存”：按 `syncFailure.source` 分别陈述事实。
5. fixture create 接受真实表单附带的 `id: undefined` 后覆盖生成 ID：模拟后端生成 ID 最后生效，覆盖 undefined/旧 ID 和后续读取、Key/Desktop/Gateway 链路。
6. 已有 Key 表单挂载需要只读预览，严格 fixture 缺少该方法而拒绝渲染：补齐真实 DTO 结构的纯合成预览，启动/文件/进程操作仍拒绝。
7. fixture 启用查询记录有额度快照却缺少持久化脚本，真实表单正确阻止保存：种子和目录复用合法 request/extractor 脚本与占位凭证，不削弱产品校验。
8. fixture 将冻结的无时区 SQL 时间用在 Desktop 操作事实，导致页面正确的“本次保存之后”守卫忽略同步告警：Desktop 改用操作时刻 RFC3339，测试时允许固定时钟；账本日期格式不变。58 项 fixture 测试及 Shanghai/Los_Angeles 两时区回归通过。
9. 900×700 选线弹窗的确认按钮被默认顶部偏移与内容高度挤出视口：改为居中、视口限高的语义化布局，头尾保持可见、资源列局部滚动。正常/空/partial 均有实际边界测量与组件回归。
10. 自动化曾命中隐藏/出场中的 modal、旧 ref、provider 而非 key 的 aria-pressed，以及折叠区域之外的表格。主题矩阵首次仅修改 localStorage 未重建页面，旧截图无效；已用不同文档 query 重建并核对真实标题/主题后全部替换。先读取实际 DOM 并等待稳定条件，不以定位错误修改产品。

这些问题已归纳到 [测试与验收规范](../../spec/cc-use/frontend/testing-and-quality.md#fixture-fidelity-regression-rules) 和 [fixture 使用说明](../../../src/renderer/dev/README.md)。核心原因是跨层真实表单/时间语义与手写 mock 之间的契约缺口，以及单元测试不覆盖实际窗口几何；对应增加最低层回归并保留浏览器闭环。未执行自动提交或模板同步：当前仓库没有 Trellis 模板源，本任务也不授权修改其安装包。

## PRD 验收证据索引

| 验收 | 主要证据 |
| --- | --- |
| A1–A2 | [Dashboard 组件回归](../../../src/renderer/pages/Dashboard.test.tsx)、[本地日期/受控区间回归](../../../src/renderer/components/usage/UsageTimeRangePicker.component.test.tsx)、日期钻取浏览器旅程 |
| A3–A4 | [旧路由和安全 URL 回归](../../../src/renderer/components/layout/workspaceNavigation.test.ts)、导航/tray/CLI 最终 diff、完整 Rust workspace 测试 |
| A5–A6 | [实例人口与生命周期回归](../../../src/renderer/pages/Instances.test.tsx)、[选择器交互回归](../../../src/renderer/components/common/RoutePickerModal.interaction.test.tsx)、混合实例浏览器旅程 |
| A7–A9 | [Desktop 页面回归](../../../src/renderer/pages/DesktopPage.test.tsx)、[原生协调契约回归](../../../src-tauri/src/commands/desktop_connection_tests.rs)、partial/unknown/route-only/restore 浏览器旅程 |
| A10–A12 | [Key 查询回归](../../../src/renderer/pages/Keys.query.test.tsx)、[Key 表单回归](../../../src/renderer/components/keys/KeyEditModal.component.test.tsx)、[fixture 合约回归](../../../src/renderer/dev/fixtureApi.test.ts)、空资源创建与保存失败分离旅程 |
| A13 | [范围账本回归](../../../src/renderer/pages/Statistics.observation.test.tsx)、[SQL 范围查询与回归](../../../src-tauri/src/db/request_logs.rs)、[资源用量弹窗回归](../../../src/renderer/components/usage/ResourceUsageModal.test.tsx) |
| A14–A15 | [控制台交互回归](../../../src/renderer/pages/Console.component.test.tsx)、[日志存储回归](../../../src/renderer/api/consoleStore.test.ts)、[精确持久化查询](../../../src-tauri/src/services/console_log_store.rs)、留存定位浏览器旅程 |
| A16–A17 | [Gateway 回归](../../../src/renderer/pages/GatewayPage.test.tsx)、[Key 模型回归](../../../src/renderer/pages/Keys.models.test.tsx)、[IPC 调用契约](../../../src/renderer/api/__tests__/index.contract.test.ts)、Gateway 显式保存与旧模型 ID 浏览器旅程、保留能力 diff 审查 |
| A18–A19 | 选线/实例/Desktop/Console 组件回归、本文 8 组视觉矩阵和紧凑窗口/键盘专项 |
| A20 | 本文最终质量门、[隔离策略回归](../../../src/renderer/dev/isolation.test.ts)、原生未实测边界及未提交代码交付说明 |

## 最终审查与未验证边界

- 最终审查覆盖 tracked diff 和新增文件，包括路由、DTO/IPC、SQL-before-pagination、精确日志投影、Desktop/tray 一致性、选线资格、模型策略和 CLI 兼容边界。
- 没有新增持久化“线路”实体、破坏性数据库迁移、依赖升级、数据清理、自动提交或发布。
- 原生托盘外观、真实客户端重开及客户端是否已载入配置 **未实测，也不声称可可靠检测**。相关文件/session 协调由临时目录/数据库中的 Rust 回归覆盖。
- jsdom 的伪元素 `getComputedStyle` 提示，以及 Vite 混合静态/动态导入和大 chunk 提示不影响测试/构建成功；未为了本次改版升级依赖或扩大打包重构范围。
- Trellis finish-work 已执行状态检查；按其未提交代码门槛停止自动归档/日志提交。遵守“不自动提交”授权边界，任务保留供代码审阅与后续提交。
