# cc-use

一个用于管理多个 Claude Code / Codex CLI 配置的 CLI 工具，支持快速切换不同 API 来源和密钥。

[English](./README.md)

> **v1.0.0 重大变更**: 项目已从 `cc-switch` 更名为 `cc-use`。此版本与旧版 cc-switch 不兼容。请参阅 [从 v0.x 升级](#从-v0x-升级cc-switch) 了解迁移方法。

## 功能特性

- **多 CLI 支持** - 同时管理 Claude Code 和 Codex CLI 供应商
- **WebUI 管理** - 可视化界面管理供应商和配置
- **公共环境变量** - 所有供应商共享（全局或按 CLI 类型）
- **用量追踪** - 可选的供应商用量配额显示
- 交互式供应商选择
- 支持自更新
- 跨平台支持（macOS、Linux、Windows）

## 安装

### 快速安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/mipawn/cc-use/main/scripts/install.sh | bash
```

### 手动安装

从 [Releases](https://github.com/mipawn/cc-use/releases) 下载适合你平台的二进制文件，放到系统 PATH 目录中即可。

## 命令补全（Tab）

安装时会自动配置命令补全。如果补全没生效，可手动添加：

**Zsh:** 在 `~/.zshrc` 中添加：

```bash
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

然后生成补全文件：

```bash
mkdir -p ~/.zsh/completions
cc-use completion zsh > ~/.zsh/completions/_cc-use
```

**Bash:**

```bash
mkdir -p ~/.local/share/bash-completion/completions
cc-use completion bash > ~/.local/share/bash-completion/completions/cc-use
```

**Fish:**

```bash
mkdir -p ~/.config/fish/completions
cc-use completion fish > ~/.config/fish/completions/cc-use.fish
```

## 卸载

```bash
cc-use uninstall
```

## 使用方法

### 交互模式

直接运行 `cc-use` 进入交互式供应商选择：

```bash
cc-use
```

### 命令列表

| 命令                        | 说明                       |
| --------------------------- | -------------------------- |
| `cc-use`                    | 交互式选择供应商并启动 CLI |
| `cc-use list`               | 显示所有供应商             |
| `cc-use list --type claude` | 仅显示 Claude Code 供应商  |
| `cc-use list --type codex`  | 仅显示 Codex CLI 供应商    |
| `cc-use config`             | 打开 WebUI 管理供应商      |
| `cc-use update`             | 检查并安装更新             |
| `cc-use uninstall`          | 卸载 cc-use                |
| `cc-use completion <shell>` | 生成 shell 补全脚本        |
| `cc-use --help`             | 显示帮助信息               |
| `cc-use --version`          | 显示版本号                 |

### 支持的 CLI 类型

| 图标 | 类型     | 说明        |
| ---- | -------- | ----------- |
| 🟠   | `claude` | Claude Code |
| 🟢   | `codex`  | Codex CLI   |

### 使用示例

```bash
# 交互式选择
cc-use

# 显示所有供应商
cc-use list

# 仅显示 Claude Code 供应商
cc-use list --type claude

# 打开 WebUI 管理供应商
cc-use config

# 检查并安装更新
cc-use update
```

## 配置说明

### WebUI 管理

运行 `cc-use config` 打开 WebUI（`http://localhost:9527`）。WebUI 支持：

- 添加、编辑、删除供应商
- 配置公共环境变量（全局或按 CLI 类型）
- 设置供应商用量追踪
- 拖拽排序供应商

### 配置文件

配置文件存储在 `~/.config/cc-use/config.json`。

### 配置格式（v3）

```json
{
  "version": "3",
  "common": {
    "_global": {
      "API_TIMEOUT_MS": "300000"
    },
    "claude": {
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    },
    "codex": {}
  },
  "providers": [
    {
      "id": "1234567890-abc123",
      "name": "my-api",
      "type": "claude",
      "description": "我的 API 代理",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com",
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx"
      },
      "order": 0
    }
  ]
}
```

### 公共环境变量

公共环境变量会被所有供应商共享，可在三个层级配置：

- **全局（`_global`）** - 应用于所有供应商，不区分 CLI 类型
- **Claude（`claude`）** - 仅应用于 Claude Code 供应商
- **Codex（`codex`）** - 仅应用于 Codex CLI 供应商

供应商自身的变量优先级高于公共变量。

### 常用环境变量

| 变量                                       | 说明                       |
| ------------------------------------------ | -------------------------- |
| `ANTHROPIC_BASE_URL`                       | 自定义 API 端点 URL        |
| `ANTHROPIC_AUTH_TOKEN`                     | API 认证令牌               |
| `ANTHROPIC_API_KEY`                        | API 密钥（令牌的替代方式） |
| `API_TIMEOUT_MS`                           | API 请求超时时间（毫秒）   |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用遥测                   |

## 工作原理

cc-use 通过子进程方式启动 CLI（Claude Code 或 Codex），并将配置中的环境变量传入子进程。环境变量在运行时合并：`common._global` + `common.<type>` + `provider.env`（供应商优先）。

```typescript
// 合并顺序：common._global -> common.<type> -> provider.env -> process.env
const mergedEnv = { ...common._global, ...common[type], ...provider.env };
spawn(cliCommand, args, {
  env: { ...process.env, ...mergedEnv },
  stdio: "inherit",
});
```

**等效的 shell 命令：**

```bash
# Linux/macOS
ANTHROPIC_BASE_URL=https://api.example.com ANTHROPIC_AUTH_TOKEN=sk-xxx claude

# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL="https://api.example.com"; $env:ANTHROPIC_AUTH_TOKEN="sk-xxx"; claude
```

## 从源码构建

需要安装 [Bun](https://bun.sh) 运行时。

```bash
# 安装依赖
bun install
cd webui && bun install && cd ..

# 开发模式运行 CLI
bun run dev

# 开发模式运行 WebUI（另开终端）
bun run dev:webui

# 构建二进制文件（包含 WebUI）
bun run build

# 构建所有平台
bun run build:all
```

### 构建脚本

| 脚本                  | 说明                              |
| --------------------- | --------------------------------- |
| `bun run dev`         | 开发模式运行 CLI                  |
| `bun run dev:webui`   | 开发模式运行 WebUI（Vite）        |
| `bun run build:webui` | 构建 WebUI                        |
| `bun run embed:webui` | 将 WebUI 嵌入 CLI                 |
| `bun run build`       | 构建 CLI 二进制文件（包含 WebUI） |
| `bun run build:cli`   | 仅构建 CLI 二进制文件             |
| `bun run build:all`   | 构建所有平台                      |

## 支持平台

- macOS（Apple Silicon / Intel）
- Linux（x64）
- Windows（x64）

## 从 v0.1.3 升级（cc-switch）

**v1.0.0 与旧版 cc-switch 不兼容。** 项目已从 `cc-switch` 更名为 `cc-use`，配置格式也已变更。

### 卸载旧版本

```bash
# 卸载 cc-switch（旧名称）
cc-switch uninstall

# 然后安装 cc-use v1.0.0
curl -fsSL https://raw.githubusercontent.com/mipawn/cc-use/main/scripts/install.sh | bash
```

### 手动删除（如果 cc-switch uninstall 无法使用 或者 版本比较旧）

```bash
# 删除二进制文件
sudo rm /usr/local/bin/cc-switch

# 删除旧配置（可选，路径不同）
rm -rf ~/.config/cc-switch

# 删除 shell 补全
rm -f ~/.zsh/completions/_cc-switch
rm -f ~/.local/share/bash-completion/completions/cc-switch
rm -f ~/.config/fish/completions/cc-switch.fish

# 删除 shell 配置中添加的内容（如有）
# 编辑 ~/.zshrc 删除 cc-switch 补全相关的行
# 编辑 ~/.bashrc 删除 cc-switch 补全相关的行
```

## 开源协议

MIT
