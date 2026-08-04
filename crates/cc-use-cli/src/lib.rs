//! `cc-use` — 终端启动入口。
//!
//! 定位只有一个：在你所在的终端里把 Claude Code / Grok Build 跑起来 ——
//! 每次从兼容线路列表里挑一条，GUI 配置的项目默认线路会预选中。
//! 启动之后终端归 TUI 所有，管理（热切换、实例、统计）都在 GUI 里，
//! CLI 不做第二套。

pub mod cmds;
pub mod format;

use clap::{Parser, Subcommand};
use cmds::Ctx;

#[derive(Parser)]
#[command(
    name = "cc-use",
    version,
    about = "在当前终端启动 Claude Code / Grok Build",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 选择一条线路，在当前终端启动 Claude Code
    Claude,

    /// 选择一条线路，在当前终端启动 Grok Build
    Grok,

    /// 供 Claude Code statusLine 调用，从 stdin 读取 JSON 并输出彩色双行 HUD
    #[command(hide = true)]
    Statusline,

    /// 一键配置 Claude Code 状态栏（写入 ~/.claude/settings.json）
    #[command(hide = true)]
    SetupStatusline {
        /// 覆盖已有的第三方 statusLine（原文件会先备份）
        #[arg(long)]
        force: bool,
        /// 移除 cc-use 的 statusLine 配置
        #[arg(long)]
        restore: bool,
    },

    /// 在 /usr/local/bin/cc-use 安装命令
    #[command(hide = true)]
    Install,
}

/// Parse argv, run the command, and exit with the right code.
pub fn run() -> ! {
    let cli = Cli::parse();

    let result = match &cli.command {
        Command::Statusline => cmds::statusline(),
        Command::Install => cmds::install(),
        Command::SetupStatusline { force, restore } => {
            if *restore {
                cmds::restore_statusline()
            } else {
                cmds::setup_statusline(*force)
            }
        }
        Command::Claude => Ctx::open().and_then(|ctx| cmds::launch(&ctx, "claude_code")),
        Command::Grok => Ctx::open().and_then(|ctx| cmds::launch(&ctx, "grok")),
    };

    match result {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            eprintln!("{}", error.message());
            std::process::exit(error.code());
        }
    }
}
