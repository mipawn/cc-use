# Command Code 查询与网关 UA 交互完善

## Goal

支持内置 Command Code 供应商完成需要两个接口的账户查询，并使网关 User-Agent 交互与应用现有入口一致。

## Background and Constraints

- 2026-11-06 用户提出两项需求并明确同意创建 Trellis 关联任务；当前仅获立项与规划授权，尚未获最终方案实施授权。
- 初始工作区只有用户修改的 AGENTS.md；不得覆盖该修改。
- 当前脚本只有 request 与 extractor(response)，运行时只发一次 GET：[query_script.rs:187–231](<src-tauri/src/services/query_script.rs#L187-L231>)、[balance_service.rs:35–49](<src-tauri/src/services/balance_service.rs#L35-L49>)。

## Task Map

| 子任务 | 交付 | 状态 |
| --- | --- | --- |
| [Command Code 双接口查询](<.trellis/tasks/11-06-command-code-multi-query/prd.md>) | 内置供应商、可编辑双接口查询、旧脚本兼容 | 规划：调研与设计与 2026-11-06 收敛（[research.md](<.trellis/tasks/11-06-command-code-multi-query/research.md>) / [design.md](<.trellis/tasks/11-06-command-code-multi-query/design.md>) / [implement.md](<.trellis/tasks/11-06-command-code-multi-query/implement.md>)），待评审激活 |
| [网关 User-Agent](<.trellis/tasks/11-06-gateway-user-agent/prd.md>) | 复用公共 UA 输入/下拉/管理组件 | 规划：设计已记录（[design.md](<.trellis/tasks/11-06-gateway-user-agent/design.md>)），待评审激活 |

两项交付可独立验收，子任务间不存在业务依赖。父任务只负责需求地图与最终集成验收，不直接承载产品实现。

## Requirements

- R1：Command Code 可从内置供应商模板选择，账户刷新使用所需的两个接口并合并为现有账户显示字段；详情由查询子任务负责。
- R2：网关 UA 与密钥编辑/模型清单采用相同交互，共享内置和本地保存的 UA；详情由 UA 子任务负责。
- R3：保留原单接口脚本与网关默认/覆盖语义，无无关数据迁移、配置更改或秘密输出。

## Acceptance Criteria

- [ ] A1 / R1：查询子任务全部验收通过。
- [ ] A2 / R2：UA 子任务全部验收通过。
- [ ] A3 / R3：相关前后端测试、类型检查、lint 与格式检查通过；中英文同步，原供应商和网关配置保持兼容。

## Out of Scope

- 不开发新的 Command Code 客户端启动入口、网关协议转换、全站 UI 重构或新的网关 Header 编辑器。
- 不自动提交、发布、安装应用或重启生产 daemon；不修改 DSH。

## Open Questions

- ~~Command Code 两个查询接口的确切地址、鉴权、响应结构与是否有先后依赖尚未明确~~ 已消除：`GET https://api.commandcode.ai/alpha/billing/credits` 与 `/alpha/billing/subscriptions`，Bearer {{apiKey}}，两请求独立无先后依赖；证据与响应契约见查询子任务 [research.md](<.trellis/tasks/11-06-command-code-multi-query/research.md>) 与 [design.md](<.trellis/tasks/11-06-command-code-multi-query/design.md>)。评审门槛只剩 optional 语义与月窗快照两项呈给用户确认。
