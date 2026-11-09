# 实施计划：统一供应商与密钥额度查询交互

## Start Review Gate

- [x] PRD R1–R7 / A1–A7 明确，D1–D5 已由用户确认。
- [x] 代码证据与跨层边界已检查，复杂任务 design/implement 完整。
- [ ] 用户在最新最终规划摘要之后明确批准。
- [ ] `task.py start .trellis/tasks/11-09-quota-query-ux` 成功，status=in_progress。

未完成这两个 gate 前不修改产品代码、不派发实施。

## Ordered Work

### 1. Contract, Catalogue and Storage

- [ ] 记录现有未提交 Command Code diff/测试作为保留基线，不回退、不重复迁移。
- [ ] 新建 Rust query_schemes：scope、IDs、凭据 metadata，复用现有脚本；账户与 New API key 目录独立。
- [ ] 对历史脚本做有证据的归类，识别明确账户密钥脚本；不按 presetId 猜，不替换原文。
- [ ] 新增 QueryConfig/queryConfig，SQL CREATE + ALTER + mapper + SELECT + INSERT + UPDATE 完整连通。
- [ ] legacy null 状态解析，关闭保留，未知/错误 scope 安全处理；DefaultKeyConfig 补齐 usageScript，不把账户示例作为密钥默认值。
- [ ] Rust/TS DTO、Create/Update、Export 同步；复制、两种 import 路径和 secret redaction 不退化。
- [ ] 写真实临时数据库 migration/重复升级/原文保留/关闭恢复/round-trip 测试。

### 2. Runtime, Draft Test and Cache Ownership

依赖步骤 1 契约。

- [ ] balance/usage service 根据有效启用配置执行；密钥不借账户 token/userId，已知账户查询拒绝运行。
- [ ] 复用 resolver/GET/origin/credentials/http client，新增无持久化草稿测试服务和可注入 sender 离线测试。
- [ ] typed query_schemes/query_test command + invoke registration；单/多请求 save-check TS 报告补齐。
- [ ] 测试、错误、invalidMessage 输出脱敏，不返回 raw response/headers/credential-bearing URL。
- [ ] key 输出不带窗口/groups，window-only 不作为密钥额度成功；保留 null/真实 0 差异。
- [ ] 更新事务中失效受影响缓存；key value 以及 provider fallback credential 变化均覆盖。
- [ ] await 后输入快照一致才写正式缓存；测试从不写缓存、实体、检查时间。
- [ ] 增加跨输入变更/关闭期间迟到响应、同配置失败留缓存、不同配置清缓存测试。

### 3. Renderer Integration

依赖步骤 1–2 的公开 API；UI utilities/tests 可先对已确定接口编写。

- [ ] API types/buildApi 与契约测试接入 typed 目录/草稿测试。
- [ ] 共享查询设置组件：开关、scope 目录、凭据说明、自定义代码显式入口、测试/预览。
- [ ] ProviderModal 独立账户查询区；不改变名称/图标/推理地址/模型/客户端配置。
- [ ] KeyEditModal 密钥额度区：新建明确选择才启用、关闭保留、无方案说明、不继承账户脚本。
- [ ] 已知账户旧密钥脚本原文保留、禁用提示与可执行修复入口。
- [ ] 草稿 revision/迟到响应 guard；改输入、关闭、换记录后旧成功立即消失。
- [ ] Keys 保存后刷新覆盖 credential change，所有刷新 eligibility helper 使用 enabled/scope；ProviderCard 按当前配置展示。
- [ ] 密钥卡片/测试/预览移除周期窗口与账户兜底，供应商周期展示不退化。
- [ ] zh/en 同步；antd API 先查询，触碰文件格式化，不 repo-wide reformat。
- [ ] 组件/工具测试覆盖 A1–A7 和复制、关闭重开、取消测试、选择器不改非查询字段。

### 4. Integration Quality Gate

- [ ] Lead 审阅相对保留基线的完整 diff，排查写域交叠与 unrelated changes。
- [ ] Rust fmt/build/clippy/workspace tests，无新增 warning；侧车依然可编译。
- [ ] Frontend typecheck/lint/full tests/build，antd touched-file lint，无新增 warning。
- [ ] A1–A7 各有验收证据；缺少原生 Tauri/真实供应商人工验证时明确列为未验证，不能假称已完成。
- [ ] 测试仅合成 fixture/temp DB；无真实密钥、无真实计费/推理调用。

## Validation Commands

从仓库根目录执行；pnpm 按环境工具提供的 Node/pnpm 路径运行（如有）。

```bash
cargo fmt --all -- --check
cargo test -p cc-use --lib query_script::
cargo test -p cc-use --lib command_code_script_upgrade
cargo test -p cc-use --lib query_schemes
cargo test -p cc-use --lib query_test
cargo test --workspace
cargo build --workspace
cargo clippy --workspace
pnpm typecheck
pnpm lint
pnpm test
pnpm build:frontend
pnpm exec prettier --check <touched-frontend-files>
antd lint <touched-ui-files> --format json
```

按最终新增测试模块调整 targeted filter；检查每条命令退出状态，不把过滤到 0 个测试当成验证通过。耗时命令后台运行时记录 job ID，最终收集。

## Review / Rollback Points

1. 存储/API checkpoint：完成 migration/round-trip 后才让 UI 写新配置；不得修改 CREATE 而漏 ALTER。
2. runtime checkpoint：草稿服务与正式刷新必须同等限制；key 账户脚本禁用不能只发生在 UI。
3. cache checkpoint：DB clear 与异步晚到写回都验证；借用密钥改变的账户缓存不能漏清。
4. compatibility checkpoint：不改旧脚本原文，未知自定义保留；原 Command Code 修复测试继续通过。
5. downgrade caveat：旧版不理解 queryConfig，会忽略新增 disabled 状态；记录风险，不自动删脚本作为回滚。

## Finish

- [ ] `trellis-check` 通过；按 A1–A7 写 acceptance.md，报告真实的验证范围。
- [ ] `trellis-update-spec` 沉淀 scope/config/test/cache 契约，增量保留已有 query-script spec。
- [ ] 补充 CHANGELOG 用户可见行为，确认不卷入无关修改。
- [ ] 按 Trellis commit gate 处理提交，未授权时提醒用户提交，不擅自推送。
- [ ] 通过 `trellis-finish-work` 更新 journal，完成任务记录/归档；未完成质量 gate 不报告完成或归档。
