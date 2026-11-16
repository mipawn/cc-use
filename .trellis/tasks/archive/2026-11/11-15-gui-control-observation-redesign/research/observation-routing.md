# 观测、选线与验证研究

只读源码检查；未执行测试、历史浏览器脚本或启动服务。研究补充了“跳转”必须依赖的真实契约。

## 统计与控制台

- 当前统计和分页请求只接受时间，资源统计才带provider/key范围：[Statistics](<src/renderer/pages/Statistics.tsx#L58-L160>)、[ResourceUsageModal](<src/renderer/components/usage/ResourceUsageModal.tsx#L100-L122>)。实例/资源进入完整账本需要共享后端过滤，不是分页后前端筛选。
- 今日请求只计四项Token任一大于0，失败计outcome非空且非success：[overview查询](<src-tauri/src/db/request_logs.rs#L678-L709>)。添加population条件，确保点击数字得到同口径结果；保留Token、缓存、速度统计原有定义。
- request_logs.session_id实写session token；managed_instances.session_token唯一，可后端按instance ID关联：[写入](<src-tauri/src/proxy/handler.rs#L2584-L2588>)、[表定义](<src-tauri/src/db/mod.rs#L339-L347>)。session token是认证凭据，绝不放URL。
- 请求ID在入口生成并贯穿日志/账本：[handler.rs:326](<src-tauri/src/proxy/handler.rs#L326>)、[handler.rs:366](<src-tauri/src/proxy/handler.rs#L366>)、[handler.rs:901](<src-tauri/src/proxy/handler.rs#L901>)、[handler.rs:2588](<src-tauri/src/proxy/handler.rs#L2588>)。统计→控制台使用精确requestId；无需扩展事件为资源分析schema。
- 实例清理会删除关联行：[managed_instances.rs:325–360](<src-tauri/src/db/managed_instances.rs#L325-L360>)；provider/key删除会使账本外键置空：[db/mod.rs:278–283](<src-tauri/src/db/mod.rs#L278-L283>)。旧链接失效须明确提示，显示名快照不可用来伪造原ID归属。
- 控制台只保留有限缓冲与三自然日/容量约束；持久化readRecent先读窗口再截limit：[console_log_store.rs:1724–1748](<src-tauri/src/services/console_log_store.rs#L1724-L1748>)。新增精确只读请求查询应在限量前匹配，并保留留存/截断元信息。找不到可能是未收录、清空、轮转或过期；读取失败另行提示。
- 兼容历史明确要求：控制台维持终端单行流，不恢复独立日志页、请求表格、多组筛选面板：[历史R10](<.trellis/tasks/archive/2026-10/10-28-gateway-console-provider-ux/prd.md#L175-L182>)。

## 选线与配置

- Key已有cachedUsage/lastUsageCheckedAt、启用耗尽和客户端配置：[ApiKey](<src/shared/types/index.ts#L443-L470>)；UsageData含额度、无限、过期、window/group，各窗口不能求平均：[UsageData](<src/shared/types/index.ts#L140-L168>)。
- Provider另有账户级缓存与时间；展示必须区分账户额度和密钥额度。最新key-scope迁移已明确入口及缓存规则：[quota-key-scope PRD](<.trellis/tasks/archive/2026-11/11-12-quota-key-scope/prd.md#L14-L24>)。
- 当前RoutePicker在apiKeys刷新时可能重置选择/搜索，onSelect若吞错则正常关闭：[选择器状态](<src/renderer/components/common/RoutePickerModal.tsx#L129-L172>)。新宿主要按打开事务初始化，数据刷新只重新校验，不抹掉用户操作。
- 复用现有provider/key表单，返回新实体对象供宿主选择；取消/失败回原操作，创建成功也不自动应用线路。改版过程中不可复制完整的模型/查询表单逻辑。
- Gateway资格与连接/模型策略独立，不套clientKind，不继承Key模型映射；保留旧缺失ID、默认all/Bearer、编辑取消语义，依据[现有网关](<src/renderer/pages/GatewayPage.tsx>)及[API边界](<.trellis/spec/cc-use/frontend/api-bridge.md#L140-L198>)。

## 安全浏览器验证

没有正式E2E框架，当前是Vitest/jsdom：[测试规范](<.trellis/spec/cc-use/frontend/testing-and-quality.md#L7-L21>)。仓库git-ignored历史浏览器脚本有合成数据与IPC拦截范例，但未知命令默认空数组会隐藏遗漏，数据也落后；不得直接运行旧Playwright脚本当验收。

实施时增加仅开发模式可启用的严格fixture API/事件源：允许列表、未知方法报错、只在内存修改、调用审计、无Tauri/Keychain/daemon访问且无真实API回退；覆盖空、成功、慢、失败、partial、耗尽、长名称、多实例。先加载ego-browser技能再开独立TaskSpace验证；测试页面不能是DSH当前GUI，也不替换用户运行中的服务。

## 重点回归

- [桥接契约测试](<src/renderer/api/__tests__/index.contract.test.ts>)：可选筛选参数、desktop结构化结果、控制台requestId查询。
- [资源统计测试](<src/renderer/components/usage/ResourceUsageModal.test.tsx>)：scope、迟到响应、刷新不丢过滤。
- [实例测试](<src/renderer/pages/Instances.test.tsx>)：按行兼容、别名、多实例、进行中与失效状态。
- [网关测试](<src/renderer/pages/GatewayPage.test.tsx>)：all/Bearer默认、模型策略和缺失ID保留。
- [控制台组件测试](<src/renderer/pages/Console.component.test.tsx>)与[纯过滤测试](<src/renderer/pages/consoleFilters.test.ts>)：单行流、暂停/搜索/清空、request定位与无匹配。
- 新增选线create-return/取消/失败不关闭/单次提交/轮询不重置/额度单位、时间与归属测试；热力图键盘/日期/失败状态与数据库筛选计数测试。
