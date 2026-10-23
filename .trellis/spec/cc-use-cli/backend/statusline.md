# Statusline

`cmds::statusline()` is invoked by Claude Code on every status-bar refresh: Claude Code writes a JSON payload to stdin and renders our stdout. It is configured by `cc_use_lib::statusline_config` as the absolute path plus ` statusline` (see `cmds::setup_statusline`), so it works without the global `cc-use` symlink.

Two hard rules:

1. **It must never fail an interactive Claude Code session.** Every error path degrades: `Database::new().ok()`, `.ok()?` for DB reads, git failures are omitted, and the function returns `Ok(())` on all paths (its doc comment states that "statusline failures never interrupt an interactive Claude Code session"). Keep it that way; do not introduce `?` on an optional lookup or print diagnostics to stdout.
2. **stdout is a UI contract.** Claude Code renders the lines verbatim, and the CLI tests pin line count and substrings. Change the layout only with tests and `guides/CLI.md` updates.

## Input parsing

`parse_statusline_input(raw)` ignores unparseable JSON (falls back to `StatuslineInput::default()`); it reads JSON pointers:

| Field | Pointer |
| --- | --- |
| model display name | `/model/display_name` (fallback `"Claude"`) |
| current directory | `/workspace/current_dir` |
| top-level cwd | `/cwd` |
| workspace project dir | `/workspace/project_dir` |
| context usage | `/context_window/used_percentage` |
| cache usage | `/context_window/current_usage` |

Instance ownership comes **only** from the `CC_USE_INSTANCE_ID` environment variable (injected by the wrapper script). The code deliberately does not infer an instance from the current directory, because another managed window may be running in the same project. The id must match an entry in `managed_instance_list_active()` with status `launching`, `running`, or `stale`.

## Directory and heading

`resolve_statusline_dir` picks the first available of:

1. `workspace.current_dir`
2. top-level `/cwd`
3. the managed instance's saved `project_path`
4. `workspace.project_dir`
5. the directory the CLI was invoked from

If the resolved path is the same directory as the instance's saved path, the instance's logical spelling is displayed (the user typed it). The heading is the last path segment, capped at 24 chars; `/` shows as `/`; with no directory at all the heading is `CC USE`. A bound project never overrides the title when the session is running in a subdirectory (`statusline_heading_shows_the_actual_directory_under_an_ancestor_project`).

## Output layout

Unmanaged session (2 lines):

```text
<dir> │ unmanaged
[<model>] │ Context ████░░░░░░ 42% │ Cache 85.0%
```

Managed session (3 lines):

```text
<dir> │ <provider> / <key alias> │ <instance short code>
[<model>] │ git:(<branch>[*]) │ Context ... │ Cache ...
Last 100.0 tok/s │ TTFT 2.00s
```

- Line 1 route: provider name (max 18) / key label (max 20) — `key_label` is the alias, or the id when no alias — plus the last 8 characters of the instance id (`instance_short_code`). Missing lookups render `Unknown provider` / `Unknown key`.
- Line 2: model (max 20) in brackets, optional git segment, context meter, cache indicator. Segments are joined by an ANSI-colored ` │ `.
- Line 3 appears only for a managed instance. `request_log_session_performance` supplies the last settled request's output speed and first-token time; formatting is `Last {:.1} tok/s` / `Last — tok/s` and `TTFT {:.2}s` / `TTFT —`. This is a settled-request observation, never a live estimate.
- All arbitrary strings pass through `safe_status_text`, which strips control characters and ellipsizes. This prevents payload/project names from injecting terminal escapes (`statusline_text_strips_terminal_control_characters`).

## Metrics

- **Context meter** (`context_meter`): clamp `used_percentage` to 0–100 (missing → 0), 10 cells `█`/`░`, color green < 70, yellow ≥ 70, red ≥ 90. Shows `{:.0}%`.
- **Cache indicator** (`cache_indicator`): `{:.1}%` or `—` when unavailable. `cache_hit_percentage` requires all three of `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` as `u64` and a non-zero total; otherwise `None`. Formula: `cache_read / (input + cache_read + cache_creation) * 100`. Output tokens never participate. The distinction between "no data" (`—`) and a real `0.0%` is deliberate and tested.
- **Git** (`git_status`): runs `git status --porcelain=v1 --branch --untracked-files=normal` in the display directory with `LC_ALL=C`, only when the directory exists. Branch parsing handles `No commits yet on <branch>` and `HEAD (no branch)` → `detached`; a dirty tree appends `*`; the branch is capped at 22 chars; any failure omits the segment entirely.

## Colors

ANSI helpers: `ansi(code, value)` (statusline) and `picker_color(code, value)` (launch picker). Both return the raw value when `NO_COLOR` is set (presence check, any value). Palette constants `STATUS_CYAN` / `STATUS_BLUE` / `STATUS_YELLOW` / `STATUS_GREEN` / `STATUS_RED` are 256-color / true-color mid-tones and deliberately non-bold (`statusline_palette_uses_muted_non_bold_colors`). The tests run child processes with `NO_COLOR=1` and assert stdout contains no `\x1b`.

Do not add bold, background colors, or palette changes without a visual reason and a test update; the status line sits permanently in every Claude Code session.

## Performance and dependencies

A refresh runs a DB open, a few reads, and possibly one `git` subprocess. Keep it that way: no network calls, no daemon HTTP calls, no long scans, and no writes. `request_log_session_performance` is the only query added for the third line; if you need new data, add a bounded DB method rather than walking tables here.

## Related

- Setup/restore of the `statusLine` setting: `cmds::setup_statusline` / `cmds::restore_statusline` and `src-tauri/src/statusline_config.rs` (backup file `settings.json.pre-cc-use-statusline.bak`, refuses to clobber a third-party `statusLine` without `--force`).
- Wrapper that sets `CC_USE_INSTANCE_ID`: `src-tauri/src/terminal/mod.rs`.
- User-facing behavior and the exact field meanings: `guides/CLI.md` and `guides/REQUEST_PERFORMANCE.md`.
