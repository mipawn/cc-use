# Auto mode 与本地分类器兼容

日期：2026-10-26

## 最新版 Claude Code 的行为（2.1.278+）

- Auto mode 是交互会话的默认权限模式。
- 只要 `ANTHROPIC_BASE_URL` 指向网关，Claude Code 默认把安全审查放在**会话自己的模型请求**里，由服务端带内完成。
- 请求体多出 `safeguards` 字段（含 `classifier_context`），响应或最后一个 `message_delta` 需要带回 `safeguard_results`。
- 网关拿不到或读不懂审查结果时，Claude Code 回退到自己的**本地分类器**；在会计费的账号上会提示分类器请求开始计费。

## cc-use 3.15.0 的选择

### 默认不干预

- 不注入任何 auto-mode 相关环境变量。
- 不修改 auto mode 的 `model` / `thinking` / `effort` / `max_tokens` / 采样参数。
- `safeguards` / `safeguard_results` / `anthropic-beta` 原样透传。
- 代理不再识别并改写客户端分类器请求的模型；`request_kind=auto_mode` 仅用于控制台和统计标记。

### 按 Key 显式开启「Auto mode 兼容（本地分类器）」

在 Key 的模型映射高级设置中开启，并填写分类器模型后，启动 Claude Code 时注入：

```bash
CLAUDE_CODE_AUTO_MODE_SERVER=0
CLAUDE_CODE_AUTO_MODE_MODEL=<分类器模型>
```

- `CLAUDE_CODE_AUTO_MODE_SERVER=0`：不再请求服务端审查，避免首个动作被计费提示挂起。
- `CLAUDE_CODE_AUTO_MODE_MODEL`：让本地分类器使用该供应商实际提供的模型。自定义模型需要 Claude Code **2.1.302+**。
- 环境变量只对新启动的会话生效；**修改后需要重新启动 Claude Code 会话**。
- Key / 全局 Claude 配置里显式设置的同名变量优先，不会被覆盖。
- 分类器模型为空时不注入，UI 会提示必须填写。

### 计费与隐私

- 本地分类器请求经 cc-use 代理转发，会计入该 Key 的 token 用量。
- 分类器请求会携带一段会话上下文，模型供应商能看到这部分内容；请选择可信的分类器模型。

## 兼容性

- Claude Code < 2.1.278：不识别这些变量，行为不变。
- 2.1.278–2.1.301：`SERVER=0` 生效，`MODEL` 被忽略，分类器使用默认模型。
- ≥ 2.1.302：两个变量均生效。
- `CLAUDE_CODE_AUTO_MODE_SERVER` 被官方标注为临时设置；若后续移除，Claude Code 仍会回退到本地分类器，只是可能出现计费提示。

## 验收

- 关闭开关：启动 env 不含 `CLAUDE_CODE_AUTO_MODE_SERVER` / `CLAUDE_CODE_AUTO_MODE_MODEL`，请求原样透传。
- 开启并填写模型：预览与实际启动 env 均包含两个变量；会话内 `/status` 显示 `Auto mode server: Disabled`。
- 代理不再改写分类器请求的 model / thinking / effort。
- 修改开关或模型后，新会话生效，旧会话不受影响。

## 来源

- https://code.claude.com/docs/en/llm-gateway-protocol
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/auto-mode-classifier-billing
- https://docs.litellm.ai/docs/claude_code_auto_mode
