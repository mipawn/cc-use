# Database

> SQLite access for the backend: rusqlite, no ORM, one module per table, ALTER-only
> migrations. Primary files: `src-tauri/src/db/mod.rs` (connection + migrations) and
> `src-tauri/src/db/<table>.rs` (queries).

---

## Library and Connection

- `rusqlite = { version = "0.32", features = ["bundled"] }`, no ORM, no query builder.
- `db/mod.rs` defines `pub struct Database { pub conn: rusqlite::Connection }`. Methods take
  `&self`; the app shares one instance via `Arc<Mutex<Database>>`.
- `Database::new()` opens the real file and runs migrations; `Database::open_at(path)`
  opens an arbitrary file (tests, Electron migration); both set
  `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
  `Database::new_in_memory()` is `#[cfg(test)]` and exists only for unit tests inside the
  library — integration tests cannot see it and must use `open_at` (see
  [quality-and-testing.md](./quality-and-testing.md)).
- File location: `dirs::data_dir()/com.mipawn.cc-use{,.dev}/data/cc-use.db` — the `.dev`
  suffix is chosen by `debug_assertions` in `db/mod.rs::app_data_dir_name`. Production is
  `~/Library/Application Support/com.mipawn.cc-use/data/cc-use.db`. Dev and prod databases
  are intentionally separate.

## Table Modules

| Table | Module |
|-------|--------|
| `providers` | `db/providers.rs` |
| `api_keys` | `db/api_keys.rs` |
| `projects`, `project_client_bindings` | `db/projects.rs` (`project_binding_upsert`, `hydrate_project`) |
| `proxy_sessions` | `db/proxy_sessions.rs` (also stores gateway outlets: `session_kind='gateway'`, `display_name`, `is_active`, `gateway_connection_config` JSON NULL; `gateway_*` queries live here) |
| `managed_instances` | `db/managed_instances.rs` |
| `request_logs` | `db/request_logs.rs` |
| `usage_logs`, usage statistics | `db/usage_logs.rs` |
| `settings` | `db/settings.rs` |
| `custom_user_agents` | `db/user_agents.rs` |
| `gateway_request_events` | `db/gateway_metrics.rs` |

`project_client_bindings` is the exception: it is a per-project extension hydrated into
`Project.bindings`, so it lives with projects instead of its own module. New tables should
get their own `db/<table>.rs` unless they are strictly an extension row of an existing
aggregate.

`db/go_preset_cleanup.rs`, `db/model_config_cleanup.rs` and `db/keychain_migration.rs` are
private modules (`mod`, not `pub mod`) invoked only from migrations. They are one-shot data
fixes, not query surfaces.

## Schema and Migration Pipeline

`db/mod.rs::run_migrations` runs, in order:

1. One `execute_batch` containing every `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
   EXISTS` statement. This batch only affects **fresh** databases; existing databases skip
   it because the tables already exist.
2. `DROP TABLE IF EXISTS discovered_sessions` (V1→V2 cleanup).
3. `run_alter_migrations()` — the upgrade path for existing databases.
4. Data cleanups: `clear_shipped_go_model_defaults()`, `clear_retired_model_overrides()`.
5. `restore_legacy_keychain_secrets(reader)` — legacy secret lift (see below).

`run_alter_migrations()` contains:

- `alter_statements: [&str]` — every `ALTER TABLE ... ADD COLUMN` ever shipped. Errors are
  swallowed with `let _ = self.conn.execute(stmt, [])` on purpose: SQLite has no
  `ADD COLUMN IF NOT EXISTS`, so “duplicate column” is the expected no-op on an
  already-upgraded database. Do not add error handling that turns that no-op into a
  failure.
- `lift_queries_onto_scripts()` — writes pre-v3.11 balance/usage settings out as scripts
  once (guarded by `IS NULL`, so an intentionally empty script `''` is preserved).
- Index creation for `request_logs.request_id` and
  `(session_id, provider_id, api_key_id, created_at)`.
- Backfills (`request_logs.outcome = 'success'` where NULL, `proxy_sessions` lifecycle
  columns), API-key type migrations (`'claude'` → `'claude_code'`), project bindings
  backfill, and `drop_transform_columns()`.

### Adding a Column (the only correct path)

Column additions must land in **all** of these places:

1. `db/mod.rs::run_alter_migrations()` → append `"ALTER TABLE <table> ADD COLUMN ..."`.
   This is the step that upgrades existing installs; per `CONTRIBUTING.md` §“新增数据库字段”,
   **changing `CREATE TABLE` alone does nothing for existing users**.
2. `db/mod.rs::run_migrations()` → add the column to the `CREATE TABLE` block too, so fresh
   installs start complete.
3. `db/<table>.rs` → add the field to the `SELECT` list, the row mapper (`row_to_*`, whose
   comments pin column indexes), and the `INSERT`/`UPDATE` parameters.
4. `models/mod.rs` → add the field to the struct (`#[serde(rename_all = "camelCase")]`),
   using `Option<T>` + `#[serde(default)]` for backward compatibility unless a value must
   exist for old rows.
5. `src/shared/types/index.ts` → mirror the camelCase field (see
   [data-model-contract.md](./data-model-contract.md)).
6. `src-tauri/tests/support/mod.rs` → builders construct `Create*Input` exhaustively; the
   compiler will point at every fixture that needs the new field.

`db/mod.rs::tests::legacy_provider_table_gains_every_missing_column` proves the intent: it
drops the new columns from a fresh database, reruns `run_alter_migrations()`, and asserts
they come back. New migration code should be verifiable the same way.

### One-Shot Data Migrations

When data has to be rewritten once (not just a column added), follow
`db/go_preset_cleanup.rs` and `db/model_config_cleanup.rs`:

- Return early if a settings marker exists:
  `settings_get_value("migration.<name>")`.
- Do all row reads/writes inside `self.conn.unchecked_transaction()`.
- Write the marker in the same transaction (`INSERT OR REPLACE INTO settings ...`) and
  `commit()`.
- Preserve user-specific data unless it exactly matches a known generated value
  (`remove_shipped_mapping` only clears the exact shipped mapping and keeps `autoMode`).

`db/mod.rs::migrate_gateway_connection_config` is the current example of a one-shot
*mapping* migration driven by a column: after the ALTER migration adds
`proxy_sessions.gateway_connection_config`, it snapshots the old implicit
`clientConfigs.claude_code` base URL / UA / explicit auth scheme into that column for
`session_kind='gateway'` rows where it is still NULL, under the marker
`migration.gatewayConnectionConfig.v1`. Rules worth copying: only fill NULL, never overwrite
an existing value, never copy unrelated settings (model mapping/roles/startup params),
keep invalid historical strings for repair instead of failing the whole upgrade, and make
the error string safe when stored JSON is corrupt (no raw JSON/secrets in the error).
It runs from `Database::new()` after `run_alter_migrations()` and before any read of a
gateway row.

`unchecked_transaction()` is used because methods take `&self`; plain
`Connection::transaction()` requires `&mut self`. Multi-row changes must be transactional —
see `db/managed_instances.rs::managed_instance_update_assignment_and_session`,
`db/mod.rs::restore_legacy_keychain_secrets`, and the two cleanup modules.

## Keychain Migration (legacy, read-only)

`db/keychain_migration.rs` reads secrets from the macOS Keychain service
`com.mipawn.cc-use.credentials` via `security_framework::passwords::get_generic_password`.
`Database::new()` passes `Some(&SystemKeychainReader)`; `open_at`/tests pass `None`.
`restore_legacy_keychain_secrets` finds rows with non-empty `api_keys.secret_ref` /
`providers.token_secret_ref`, reads the secret (or keeps an already-present plaintext
value), then in one transaction writes it to `api_keys.value` / `providers.token` and clears
the reference. A failed read aborts and leaves the references intact — proven by
`db/mod.rs::failed_keychain_restore_preserves_database_references`.

Current writes never touch the Keychain: `db/api_keys.rs::api_key_update` and
`db/providers.rs::provider_update` set `secret_ref = NULL` when a value is written.
`SECURITY.md` notes the database is not statically encrypted and Keychain integration is
planned; do not reintroduce Keychain writes (or claim encryption) without updating that
document. Never log a restored secret.

## Transactions, Partial Updates, Foreign Keys

- `PRAGMA foreign_keys = ON` is set for every connection. Deleting a provider cascades to
  `api_keys` (`api_keys.provider_id REFERENCES providers(id) ON DELETE CASCADE`) and sets
  project references to NULL. Deleting entities that request logs point at is accompanied
  by snapshot backfills — e.g. `db/api_keys.rs::api_key_delete` first writes
  `request_logs.key_alias` so history keeps a display name after the row is gone.
- Partial updates use the `add_field!` macro at the top of `db/mod.rs` plus
  `Vec<Box<dyn rusqlite::types::ToSql>>`; see `db/api_keys.rs::api_key_update` and
  `db/providers.rs::provider_update`. Empty update sets return the current row instead of
  running an invalid `UPDATE ... SET WHERE`.
- 1/0 integers are the boolean storage format; row mappers convert with
  `row.get::<_, i32>(n)? != 0` (`db/api_keys.rs::row_to_api_key`).
- Dates are strings. Entity timestamps (`proxy_sessions`, `managed_instances`,
  `request_logs`, `usage_logs`) are RFC 3339 via `chrono::Utc::now().to_rfc3339()`; the
  high-volume `gateway_request_events.created_at` reuses the console timestamp format
  `YYYY-MM-DD HH:MM:SS` and its queries compare with SQLite `datetime('now', ...)`
  (`db/gateway_metrics.rs::gateway_event_cleanup`). Do not mix the two formats in one
  column. Local-day queries use `Database::time_range_where` / `local_date_expr`
  (`DATE(col, 'localtime')`) rather than comparing raw strings.
- JSON blobs (`config`, `client_configs`, `model_mapping`, `cached_usage`,
  `default_key_config`) are stored as TEXT and parsed at the boundary. Parse failures are
  tolerated as `None` for caches; `model_mapping` is normalized through
  `shared_runtime::model_mapping::sanitize_mapping` before write.

## Retention / Cleanup

- Startup (`lib.rs` setup task): `proxy_session_cleanup_stale(30)`,
  `request_log_cleanup_old(90)`, `usage_log_cleanup_old(90)`.
- Proxied-request metrics (`db/gateway_metrics.rs::gateway_event_cleanup`): delete rows
  older than 30 days and keep at most `MAX_EVENT_ROWS = 50_000`; called by the metrics
  writer thread at startup and every 256 persisted metrics (`proxy/mod.rs`).
- The daemon sweeper (`crates/cc-use-daemon/src/runtime.rs`) marks stale/running instances
  and revokes sessions for stopped managed instances every 10 s.
- Adding a new high-volume table requires a retention rule in the same change.

## Rules for New Queries

- Put SQL in the table module, not in commands or services.
- Prefer `?` and return `rusqlite::Error`; convert to `String` only at the command
  boundary (`map_err(|e| e.to_string())`).
- Parameterize with `rusqlite::params!` / `?n`. SQL text is assembled only from code
  constants: the `add_field!` UPDATE builder (`db/mod.rs`, also in `db/api_keys.rs`,
  `db/projects.rs`, `db/providers.rs`), the time-range/date expressions
  (`Database::time_range_where`, `local_date_expr`), and shared SELECT/aggregate fragments
  such as `TOKEN_SUM` and `output_speed_sample_sql` in `db/request_logs.rs`. User input never
  becomes SQL text; `time_range_where` returns `WHERE 1 = 0` for a malformed custom range.
- Read rows through one `row_to_*` mapper per struct; duplicate column lists are how
  index drift bugs start.
- Test new queries against a real temp database (`TempDb`), not a mock.

## Anti-Patterns

- Editing only `CREATE TABLE` to add a column (existing users never get it).
- Making `run_alter_migrations()` fail on a duplicate column (breaks every upgraded install).
- A migration that writes a marker before finishing its data changes, or that runs outside a
  transaction.
- Deleting rows that request logs reference without snapshotting display names first.
- Storing secrets in a new place, or logging values read from `api_keys.value` /
  `providers.token`.
- Opening a second `Connection` in a command instead of using the managed `Database`.
- Holding the `Database` mutex while awaiting network I/O.


## R9 Provider Catalog and Gateway Policy Persistence

`provider_model_catalogs(provider_id PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
models_json TEXT, revision INTEGER, updated_at TEXT)` is an idempotent CREATE extension.
`provider_model_catalog_get` returns empty revision 0 for an existing provider without a row.
`provider_model_catalog_save(provider_id, models, revision)` validates/deduplicates real IDs,
limits count (10,000), display names and serialized bytes (8 MiB), then checks revision
and increments it within one transaction. Conflict leaves the row unchanged. Do not migrate
per-Key client catalogs into it or write Key/provider connection settings from catalog saves.

`proxy_sessions.gateway_model_policy TEXT NULL` is added to CREATE and idempotent ALTER.
Every mapper/SELECT/write carries it. SQL NULL is all; malformed JSON, unknown variants,
invalid IDs and empty selected sets fail. Omitted update preserves; explicit all resets.
Connection and policy updates are atomic. The old gateway connection migration is not rerun
or repurposed for this column. Tests: `provider_model_catalogs`, `gateway_api` and the
shared runtime policy unit tests. Full IPC/error cases are specified in
[API Bridge R9 scenario](../../cc-use/frontend/api-bridge.md#scenario-saved-provider-catalogs-gateway-restrictions-and-uploaded-icon-deletion-r9).
