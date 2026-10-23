# Errors and Exit Codes

## The two-variant error type

`crates/cc-use-cli/src/cmds.rs` defines:

```rust
pub enum CliError {
    /// Something went wrong. Exit code 1.
    Failed(String),
    /// The input was ambiguous or matched nothing; the user has to narrow it down.
    /// Exit code 2, so scripts can tell this apart from a hard failure.
    NeedsChoice(String),
}

type CmdResult = Result<(), CliError>;
```

`lib.rs::run()` prints `error.message()` to stderr and exits with `error.code()`. Commands never call `process::exit` themselves and never print their own errors.

Pick the variant by asking "can the user resolve this by choosing or re-running interactively?":

- `Failed(1)` — service down, DB open failure, no compatible route at all, launch/exec failure, install/config I/O failure.
- `NeedsChoice(2)` — the route list is required but stdin is not a TTY; the picker was cancelled; a third-party `statusLine` must be overwritten with `--force` before proceeding. The message must contain the choices, not just "pick one".

Clap's own usage errors also exit `2`; that is a clap default, not a `NeedsChoice` guarantee.

## Message conventions

- **Chinese**, matching every existing command body and `guides/CLI.md`. New messages should follow the same tone: what failed, and what the user can do next.
- One line for simple failures; multi-line only when listing choices (the non-interactive picker list).
- No `Error:`/`ERROR:` prefix — `run()` prints the message as-is to stderr.
- Include the actionable noun/flag: `用 --force 覆盖`, `用 sudo cc-use install 重试`, `先在应用内的供应商密钥页配置`, `请先打开 CC Use`.
- Never include API key values, full session tokens, or the management token.

Current examples to mirror:

| Situation | Variant | Message (abridged) |
| --- | --- | --- |
| DB cannot open | `Failed` | `无法打开 cc-use 数据库: ...` |
| DB read fails | `Failed` | `读取数据库失败: ...` (`db_err` helper) |
| Daemon not running | `Failed` | `CC Use 本地服务未运行。请先打开 CC Use，确认服务启动后再试。` |
| Invalid port setting | `Failed` | `本地服务端口配置无效: <port>` |
| No key enabled for client | `Failed` | `没有任何密钥启用了 <client>。先在应用内的供应商密钥页配置。` |
| Non-TTY route selection | `NeedsChoice` | numbered list prefixed `cc-use 需要在交互终端中选择线路：` |
| Picker cancelled | `NeedsChoice` | `已取消启动。` |
| Third-party statusLine | `NeedsChoice` | shows the current command and recommends `--force` |
| Exec failure | `Failed` | `启动失败: ...` |
| Symlink install blocked | `Failed` | explains `/usr/local/bin/cc-use` exists and was left untouched |

## Propagation rules

- Map library errors at the boundary: `prepare_cli_terminal_launch(...).map_err(CliError::Failed)`, `statusline_config::enable(...).map_err(CliError::Failed)`. The library returns `String`; do not invent a third error type.
- DB helpers use `db_err(e)` so every DB failure reads consistently.
- Do not swallow an error silently unless the feature is explicitly best-effort: `cmds::statusline` is the documented exception (it may not break Claude Code), and `install` treats "already points at this version" as success.
- An optional lookup that legitimately may be missing returns `Option`, not an error (`api_key_get(...)?` in `project_default_route` yields "no default", not a failure).

## No panics on user input

- No `unwrap()` in command code. `expect("index validated")` in `launch` is the one accepted invariant: `index` comes from `pick_key`, which only returns an index into `keys`. Keep such invariants local and obvious, or replace with `ok_or_else`.
- Avoid indexing and byte slicing on user-provided strings; use `format::ellipsize` and char-aware helpers (see [Output and Format](./output-and-format.md)).
- Terminal failures are errors (`无法打开当前终端 /dev/tty`, `无法读取终端模式`, `无法进入交互选择模式`, `读取方向键失败`, `刷新选择列表失败`), not panics. `RawTerminal::enter` returns `Result`, and `Drop` restores the terminal even on the error path.

## Exit code documentation

`guides/CLI.md` publishes the exit-code table (0 success, 1 service/route/launch failure, 2 non-interactive selection). Changing the variant mapping requires updating that table, this file, and the tests that assert `error.code()` (`launch_without_tty_lists_routes_and_exits_two`, `launch_with_no_compatible_keys_fails_with_guidance`).
