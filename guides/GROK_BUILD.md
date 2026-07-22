# Grok Build 接入指南

CC Use 把 Grok Build 作为独立的进程级客户端管理。它可以和 Claude Code 复用同一个项目目录，但供应商、密钥、启动前命令、会话和运行实例都按 Grok Build 单独管理。

## 前置条件

- macOS 上已安装 `grok` CLI，并可通过 `grok --version` 找到
- 供应商支持 OpenAI Chat Completions（`/v1/chat/completions`）
- API 密钥的适用客户端已勾选 Grok Build，并按需设置 `grok` 模型映射

## CC Use 生成的配置

每次准备或启动 Grok Build 时，CC Use 会在用户级 `~/.grok/config.toml` 中维护 `[model.cc-use]`，并保留文件里其他用户配置。不使用企业管理用的 `managed_config.toml`。

生成内容等价于：

```toml
[model.cc-use]
model = "<密钥上配置的 grok 模型，默认 grok-4.5>"
base_url = "http://127.0.0.1:<daemon-port>/v1"
name = "CC Use"
description = "Local cc-use gateway"
env_key = "CC_USE_GROK_TOKEN"
api_backend = "chat_completions"
supports_backend_search = false
```

终端实际执行 `grok -m cc-use`。`CC_USE_GROK_TOKEN` 是当次 managed instance 的 session token，不是上游真实 API Key。

## 启动与实例

1. 从侧边栏进入「Grok Build」启动台。
2. 创建或编辑项目，选择 Grok Build 兼容密钥。
3. 点击「打开」。wrapper 会在项目目录中以前台 TUI 方式启动 Grok，同时保持心跳和退出上报。
4. 当前 Grok 实例只会出现在 Grok Build 启动台的「实例」Tab。

首次进入一个目录时，Grok Build 可能询问是否信任该目录，这是 Grok 自身的正常安全提示。

## OpenAI 兼容性

Grok Build 会严格解析 Chat Completions 响应。一些兼容网关会返回 `id / object / choices / usage`，但遗漏标准 `model` 字段。CC Use 仅在 Grok Build 路由上做最小兼容处理：

- 非流式 `chat.completion` 缺少 `model` 时，补为实际转发的请求模型
- SSE `chat.completion.chunk` 缺少 `model` 时，即使 JSON 被拆分在多个网络 chunk 中也会补齐
- 上游已提供 `model` 时原样保留
- Claude Code、Codex Desktop 和 Claude Desktop 不会进入该兼容分支

## 常见问题

### 打开后终端空白

确认使用包含前台 TUI wrapper 修复的新版本。旧 wrapper 把 `grok` 放到后台，交互进程无法正常读取终端。也可在同一目录直接执行 `grok -m cc-use` 检查 Grok 自身是否能显示界面。

### `serialization error: missing field model`

该错误表示 OpenAI 兼容上游的响应缺少 `model`。新版 daemon 会同时兼容非流式和 SSE 响应。升级后需重启 CC Use，让新 daemon 生效。

### 配置没有生效

- 检查 `~/.grok/config.toml` 是否存在 `[model.cc-use]`
- 执行 `grok inspect --json` 查看当前目录实际加载的配置
- 确认本地 daemon 正在运行，且配置中的端口与设置页一致
- 修改 Rust 后端或 daemon 代码后，需重启开发应用

Grok Build 自定义模型格式可参考 [xAI Grok Build Custom Models](https://docs.x.ai/build/overview#custom-models)。
