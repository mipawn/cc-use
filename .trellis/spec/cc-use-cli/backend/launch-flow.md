# Launch Flow (`cc-use claude` / `cc-use grok`)

Both public commands run the same pipeline in `cmds::launch(ctx, client)`. `client` is `"claude_code"` or `"grok"`; the key compatibility type is normalized elsewhere (`normalize_cli_type` maps a stored `"claude"` to `"claude_code"`).

## 1. Open the context

`Ctx::open()` (used by `run()`):

- `Database::new()` — the real SQLite database for this build profile.
- `cwd` — `invocation_dir()`: the process working directory, but the logical `$PWD` spelling wins when it canonicalizes to the same directory (`prefer_logical_dir`). This keeps `/tmp/...`, symlinked workspaces, and the user's typed path visible downstream.
- `interactive` — `std::io::stdin().is_terminal()`. Route selection is always an explicit choice.
- `verify_daemon` — `true`. `Ctx::with_db` sets it to `false` for tests.

## 2. Require the local service

`ensure_daemon_available` reads `settings.proxy_port`, converts it with `u16::try_from` (invalid config is a `CliError::Failed`), opens a `TcpStream::connect_timeout` to `127.0.0.1:<port>` with a 500 ms timeout, and on failure returns:

```text
CC Use 本地服务未运行。请先打开 CC Use，确认服务启动后再试。
```

The CLI never starts the daemon. Starting and supervising it is the app's job (`src-tauri/src/lib.rs`, `src-tauri/src/commands/proxy.rs`). Do not add a start path here.

## 3. Match the project

`resolve_project(ctx)` looks at `db.project_list()` and keeps the project whose path is a prefix of `cwd`, preferring the deepest match (`path_depth_if_prefix`). A project only supplies: the default route for this client and the prelaunch command. It does not change the working directory, and a missing project is not an error — the current directory becomes the instance's project path.

## 4. Build the route list

`compatible_keys(&db, client)` returns `(Provider, ApiKey)` pairs where:

- the provider is active,
- the key is active and not `is_exhausted`,
- the key's `types` contains the client after `normalize_cli_type`.

Empty list → `CliError::Failed` with `"没有任何密钥启用了 <client>。先在应用内的供应商密钥页配置。"` (exit 1). Never auto-create keys, providers, or projects.

`project_default_route(ctx, project, client)` computes the preselected route: `project.bindings.get(client).api_key_id`, falling back to the legacy `project.api_key_id` only when `normalize_cli_type(project.cli_type) == client`. The referenced key/provider must still be active; otherwise there is no default.

## 5. Pick explicitly

`pick_key(interactive, keys, default_key_id)`:

- **Interactive**: reads from `/dev/tty` (not stdin) through `RawTerminal`, which runs `stty -g`, `stty raw -echo`, hides the cursor, and restores the saved mode plus cursor in `Drop`. Keys: Up/Down or `j`/`k` move, Enter confirms, `q`/Ctrl-C cancels. `draw_key_picker` prints to stderr; the GUI default is marked `GUI 默认`.
- **Non-interactive**: prints the numbered list in a `CliError::NeedsChoice` message (exit 2) and creates nothing. `launch_without_tty_lists_routes_and_exits_two` asserts the instance table stays empty.

Keep the terminal restoration in `Drop`; an early return or error after entering raw mode must still restore the terminal. Do not write raw-mode code outside `RawTerminal`.

## 6. Prepare the managed launch through the library

`cli_launch_context` assembles `project_id`, `project_name` (project name, or the cwd's last segment, or `"terminal"`), `working_dir`, and the prelaunch command (`project.bindings[client].prelaunch_command`, legacy fallback to `project.prelaunch_command`, empty trimmed away).

Then the CLI calls:

```rust
cc_use_lib::terminal::prepare_cli_terminal_launch(
    &ctx.db, client, &provider.id, &key.id,
    project_id, project_name, working_dir, prelaunch_command,
)
```

That library function (`src-tauri/src/terminal/mod.rs`) is where the real work lives: it writes the wrapper script under `~/.cc-use/runtime/<instance-id>.sh` (mode `0700`), creates the `ProxySession` (`session_kind = "managed"`) and the `ManagedInstance` row (`terminal_type = "cli"`, `assignment_source = "cli_launch"`), and returns `CliPreparedLaunch { instance_id, instance_label, script_path }`. The CLI must not duplicate any of it.

## 7. Hand the terminal to the wrapper

```text
stdout: 实例 <instance_label>  <provider name> · <key alias>
exec:   /bin/sh <script_path>
```

`cmds::launch` prints the instance line, then uses `std::os::unix::process::CommandExt::exec()` to replace the CLI process with the wrapper. The wrapper (generated in `src-tauri/src/terminal/mod.rs`) exports the client-specific launch env produced by `shared_runtime::launch_preview` — Claude Code gets `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` carrying the session token, while Grok Build gets its `cc-use` model config and `CC_USE_GROK_TOKEN` — and also exports `CC_USE_INSTANCE_ID`, `CC_USE_MANAGEMENT_TOKEN`, and the wrapper state variables. It then runs the optional prelaunch command, starts the client, posts `/_management/instances/heartbeat` on an interval, and posts `/_management/instances/stop` on exit. Because `exec` replaces the process, the wrapper — not this crate — owns heartbeat, stop reporting, and the child's exit code.

Consequences:
- `exec` only returns on failure; that error becomes `CliError::Failed("启动失败: ...")` (exit 1).
- The CLI does not call the management API at all; the wrapper does (see [cc-use-daemon management API](../../cc-use-daemon/backend/management-api.md)).
- Selecting a route affects only this launch. It does not persist a new GUI default and does not modify project bindings.
