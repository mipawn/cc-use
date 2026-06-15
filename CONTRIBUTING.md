# 贡献指南

感谢你对 CC Use 的兴趣!这是一个由个人维护、面向国内 Claude Code / Codex 用户的开源项目,任何贡献都欢迎。

## 🎯 项目定位

CC Use 是一个基于 **会话令牌代理(session token proxy)** 架构的 Claude Code / Codex 管理工具。与改写 `~/.claude/settings.json` 的传统方案不同,我们的核心设计原则是:

- **真实密钥永不落盘**:CLI 只拿到 `session-xxx` 令牌,真实 key 留在本地 daemon 内
- **数据面与控制面分离**:GUI 是控制面,`cc-use-daemon` 是常驻数据面
- **单点深度优先**:不做大而全的 CLI 覆盖,把 Claude Code + Codex 两件事做到极致

贡献前请先阅读 [README](../README.md) 与 [`docs/daemon-mode/`](daemon-mode/) 理解架构。

## 🛠 开发环境

**前置要求**:
- macOS 13+(目前仅支持 macOS)
- Node.js ≥ 20,pnpm 10+
- Rust stable(通过 rustup)
- Xcode Command Line Tools

**启动开发环境**:

```bash
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会自动:
1. 编译 `cc-use-daemon` sidecar 二进制
2. 启动 Vite dev server
3. 编译并启动 Tauri 主进程

> 开发模式下应用名为 `CC Use Dev`,数据目录与代理端口(22345)与生产环境隔离,可同时运行。

## 📦 代码结构

```
src/                          # 前端 (React + TS)
├── renderer/                 #   UI 代码
│   ├── pages/                #   页面(Dashboard, Keys, Settings...)
│   ├── components/           #   组件
│   ├── stores/               #   Zustand 状态
│   └── locales/              #   i18n (zh / en)
└── shared/                   #   前后端共享类型与预设
    ├── types/index.ts        #   ★ 改类型时前后端都要改
    └── presets/providers.ts  #   供应商预设库

src-tauri/                    # Tauri 主进程 (Rust)
├── src/
│   ├── commands/             #   Tauri invoke handler(每个领域一个文件)
│   ├── db/                   #   SQLite 数据层(rusqlite,非 ORM)
│   ├── models/mod.rs         #   ★ 数据模型(对应 shared/types)
│   ├── proxy/                #   代理核心(handler, key_selector, usage_parser)
│   ├── services/             #   业务服务(成本计算, 余额查询, 控制台桥接)
│   └── tray.rs               #   系统托盘
├── capabilities/default.json #   Tauri 2 权限(新命令可能需要加权限)
└── tauri.conf.json           #   主配置

crates/cc-use-daemon/         # 独立的常驻代理 sidecar 二进制
```

## 🧰 常见贡献场景

### 1. 新增一个供应商预设

最简单的贡献,适合首次参与。步骤见 [`docs/PROVIDER-PRESETS.md`](PROVIDER-PRESETS.md)。

### 2. 新增一个 Tauri 命令

1. 在 `src-tauri/src/commands/<domain>.rs` 写 `#[tauri::command]` 函数
2. 在 `src-tauri/src/lib.rs` 的 `invoke_handler!` 宏里注册
3. 如命令涉及系统权限,在 `capabilities/default.json` 添加对应 permission
4. 在 `src/renderer/api/types.ts` 的 `Api` 接口加签名
5. 在 `src/renderer/api/index.ts` 的 `buildApi()` 实现
6. 在 UI 里调用

### 3. 新增数据库字段

1. 在 `src-tauri/src/db/mod.rs` 的 `run_alter_migrations()` 追加 `ALTER TABLE` 语句(幂等)
2. 在 `src-tauri/src/models/mod.rs` 的 struct 加字段(`#[serde(rename_all = "camelCase")]`)
3. 在对应 `db/<table>.rs` 的 SELECT / INSERT / UPDATE 里加列
4. 在 `src/shared/types/index.ts` 同步 TS 类型

> ⚠️ **不要改 `CREATE TABLE` 里的列定义来加字段**——已存在的数据库不会执行新的 CREATE。新增列必须走 `run_alter_migrations()`。

## ✅ 提交前检查清单

```bash
# Rust 后端
cd src-tauri && cargo build && cargo test --workspace && cargo clippy

# 前端
pnpm tsc --noEmit && pnpm lint
```

- [ ] Rust 能编译通过,`cargo clippy` 无 warning
- [ ] TypeScript 无类型错误
- [ ] ESLint 通过
- [ ] 如果改了 i18n,`zh.ts` 和 `en.ts` 都要同步
- [ ] 如果改了 DB schema,`run_alter_migrations()` 是幂等的
- [ ] 如果加了新功能,在 `CHANGELOG.md` 的 Unreleased 段补一条

## 🌐 国际化(i18n)

目前支持中文(`zh`)与英文(`en`)。新增文案时:

1. 在 `src/renderer/locales/zh.ts` 和 `en.ts` **同步添加**
2. key 命名遵循现有惯例:按页面/模块分组(如 `settings.xxx`、`providers.xxx`)
3. 代码里用 `const { t } = useTranslation(); t('settings.xxx')`

## 🐛 报告 Bug

请通过 [GitHub Issues](https://github.com/mipawn/cc-use/issues) 提交,附上:

- CC Use 版本(在 Settings → About 查看)
- macOS 版本
- 复现步骤
- Console 页的日志截图(如有)
- 是否走代理模式

## 💡 提议新功能

建议先开 Issue 讨论需求与方案,避免做完再大改。特别欢迎以下方向的提议:

- 国内中转站兼容性问题
- 密钥池化 / 故障转移场景
- 成本统计与预算告警
- Codex 支持改进

## 📜 行为准则

保持友善、尊重。技术讨论对事不对人。对新手贡献者多一份耐心。
