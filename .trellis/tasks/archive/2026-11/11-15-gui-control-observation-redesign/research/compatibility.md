# 兼容性研究：项目退出与桌面状态

只读源码研究，未启动真实客户端、未读取真实数据库或访问密钥。当前工作区分支 main，产品代码未修改。

## 项目与 CLI

- CLI 以最深目录匹配继承默认线路及前置命令；无项目仍可启动，来源：[cmds.rs:154–209](<crates/cc-use-cli/src/cmds.rs#L154-L209>)、[cmds.rs:435–505](<crates/cc-use-cli/src/cmds.rs#L435-L505>)、[启动契约](<.trellis/spec/cc-use-cli/backend/launch-flow.md#L24-L76>)。
- GUI 删除不等于数据库删除：usage_logs.project_id 是级联删除，请求/实例关联置空，来源：[表定义](<src-tauri/src/db/mod.rs#L265-L347>)。因此不调用项目删除、不做清空迁移；旧导入导出/共享启动服务保持。
- 托盘最近项目菜单和点击调用仍存在：[tray.rs:398–438](<src-tauri/src/tray.rs#L398-L438>)、[tray.rs:593–602](<src-tauri/src/tray.rs#L593-L602>)。设计决定同 GUI 项目入口一起退出，但其他托盘功能不动；该范围在最终摘要显式展示。
- 项目统计返回字段仍由账本生成：[request_logs.rs:402–434](<src-tauri/src/db/request_logs.rs#L402-L434>)；当前统计页已以模型趋势和请求表为主，不虚构有待删除的项目图表。移除GUI项目概念入口，保留现有字段兼容和历史名称。

## 实例

- 无参数列表只含活跃实例，带客户端列表是最近100条：[列表接口](<src-tauri/src/commands/managed_instances.rs#L14-L23>)。合并页面应分别构造完整活跃列表与各客户端历史，不能简单合并两份recent而漏掉长期运行项。
- 换线后端校验状态/供应商/密钥归属/耗尽/客户端兼容并原子同步实例与session：[校验](<src-tauri/src/commands/managed_instances.rs#L33-L92>)。
- Claude 的会话、全局环境配置、状态栏等工具必须保留独立入口，不虚构 Grok 对等能力：[当前客户端页](<src/renderer/pages/ClaudeCodePage.tsx#L48-L112>)。

## Desktop

- Codex 根据完整catalog/config比较区分仅网关换线与重写配置，并在恢复后要求重开：[codex_config.rs:1028–1066](<src-tauri/src/commands/codex_config.rs#L1028-L1066>)。
- Claude Desktop 当前接管写部署模式/profile/meta，恢复文件有快照回滚：[文件操作](<src-tauri/src/commands/claude_desktop_config.rs#L175-L246>)。现有profile比较并不覆盖全部部署状态：[比较器](<src-tauri/src/commands/claude_desktop_config.rs#L270-L305>)，不能直接据此宣布无需重新打开。
- 自动模型重写入口包括密钥编辑和启动同步：[api_keys.rs:29–35](<src-tauri/src/commands/api_keys.rs#L29-L35>)、[lib.rs:263–274](<src-tauri/src/lib.rs#L263-L274>)；托盘也调用接管：[tray.rs:610–634](<src-tauri/src/tray.rs#L610-L634>)。因此说明持久化属于共享后端，不放在React成功回调里。
- 路由session可能先改变、后续配置写入失败；文件快照不自动回滚数据库。设计必须处理partial并回读真实状态，不保证失败就完全没改。
- 最后一次配置变更与最后一次路由切换分开存储；纯换线、幂等启动同步、新请求和说明折叠都不能伪装为已确认加载。

## 规范锚点

- [后端架构](<.trellis/spec/cc-use/backend/architecture.md>)、[IPC契约](<.trellis/spec/cc-use/backend/tauri-commands.md>)、[模型镜像](<.trellis/spec/cc-use/backend/data-model-contract.md>)、[安全错误](<.trellis/spec/cc-use/backend/errors-and-logging.md>)。
- [CLI启动契约](<.trellis/spec/cc-use-cli/backend/launch-flow.md>)、[CLI测试](<.trellis/spec/cc-use-cli/backend/testing.md>)。
