# 安全策略

## 报告漏洞

如果你发现安全漏洞,**请不要开公开 Issue**。请私下报告:

- 邮件:mipawn(见 GitHub profile)
- 标题加 `[SECURITY]` 前缀

请在报告中说明:
- 漏洞类型与影响范围
- 复现步骤
- 受影响的版本

我会在 **48 小时内**确认收到,并在确认后尽快给出修复时间表。

## CC Use 的安全设计

CC Use 在架构上有一个核心安全特性,贡献代码时请务必保持:

### 会话令牌隔离(Session Token Isolation)

- CLI 进程(Claude Code / Codex)**永远拿不到真实 API 密钥**
- 它们只获得一个 `session-xxx` 格式的临时令牌,指向 `localhost:<port>` 的 daemon
- 真实密钥仅存在于:
  - 加密的 SQLite 数据库(`cc-use.db`)
  - daemon 进程内存(用于转发请求时注入 auth header)

这意味着:
- 即使 CLI 进程被注入恶意 prompt 或读取环境变量,泄露的也只是临时令牌
- 令牌失效后无法反推真实密钥
- 关闭 CC Use 后,daemon 停止,令牌立即失效

### 贡献代码时的安全红线

以下改动会破坏安全模型,PR 会被拒绝:

1. ❌ 将真实密钥写入 `~/.claude/settings.json` 或 `~/.codex/config.toml`
2. ❌ 在启动终端时把真实密钥作为环境变量注入
3. ❌ 在日志、Console 页、错误信息中输出完整密钥(只允许输出掩码后的形式,如 `sk-...xxxx`)
4. ❌ 把密钥上传到任何远端服务(云同步、遥测、崩溃报告)

### 本地存储

- 数据库文件位置:`~/Library/Application Support/com.mipawn.cc-use/data/cc-use.db`
- 当前**未做静态加密**(依赖 macOS 的用户级文件权限保护)
- 计划:后续支持 macOS Keychain 集成,密钥从数据库迁移到 Keychain

## 支持的版本

安全修复只针对最新一个 release 分支。请确保使用最新版本。
