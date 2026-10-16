//! tmjLite behind a thread-safe handle: users, profiles, permissions, the
//! audit log and the Rightsizing rollups live in one `.tmjp` file on the
//! pod's volume.
//!
//! The engine comes from the `tmjlite` crate, which ships the prebuilt native
//! library and loads it at runtime. Everything goes through its
//! `SharedConnection`: SELECTs run on MVCC snapshots in parallel, writes
//! serialize inside the engine and are durable when the call returns, and
//! BEGIN/COMMIT bind to the calling thread.
//!
//! This module keeps the narrow facade the rest of the server was written
//! against — `exec`, `query`, `fold`, cells as text — so the engine can move
//! underneath without touching a hundred call sites.
//!
//! Values still reach SQL as quoted literals through [`sql_str`]; nothing may
//! interpolate a raw string into a statement.

use std::borrow::Cow;
use std::path::Path;

/// Cells come back from the driver typed (it parses the engine's text).
/// The facade hands them on as text, which is what every caller was written
/// against; numbers and booleans print the way the engine stored them.
fn cell_text(value: &tmjlite::Value) -> Option<Cow<'_, str>> {
    match value {
        tmjlite::Value::Null => None,
        tmjlite::Value::Text(s) => Some(Cow::Borrowed(s.as_str())),
        other => Some(Cow::Owned(other.to_string())),
    }
}

fn err(e: tmjlite::Error) -> String {
    e.to_string()
}

/// The current row of a streaming cursor. Copy what you keep: the row is
/// dropped as soon as the fold step returns.
pub struct Row<'c> {
    inner: &'c tmjlite::Row,
    cells: Vec<Option<Cow<'c, str>>>,
}

impl<'c> Row<'c> {
    fn new(inner: &'c tmjlite::Row) -> Self {
        Row { inner, cells: inner.values().iter().map(cell_text).collect() }
    }

    /// `None` for SQL NULL.
    pub fn text(&self, col: usize) -> Option<&str> {
        self.cells.get(col).and_then(|c| c.as_deref())
    }

    pub fn i64(&self, col: usize) -> Option<i64> {
        self.inner.get_int(col)
    }

    pub fn f64(&self, col: usize) -> Option<f64> {
        self.inner.get_float(col)
    }

    pub fn bool(&self, col: usize) -> Option<bool> {
        self.inner.get_bool(col)
    }
}

/// Default ceiling for the engine's in-RAM table cache. The shared handle
/// keeps every table it WROTE resident — the rollups, written all day by the
/// collectors — and without a ceiling that was the web pod's 2 GiB that never
/// came back. Above the budget, after a durable write, the engine drops the
/// cache and returns the memory to the OS.
const DEFAULT_MEMORY_BUDGET: u64 = 256 * 1024 * 1024;

/// TMJLENS_DB_MEMORY_BUDGET in MiB; 0 turns the ceiling off.
fn memory_budget() -> u64 {
    std::env::var("TMJLENS_DB_MEMORY_BUDGET")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|mib| mib * 1024 * 1024)
        .unwrap_or(DEFAULT_MEMORY_BUDGET)
}

pub struct Db {
    conn: tmjlite::SharedConnection,
}

/// Where the server keeps the database: TMJLENS_DB_PATH, or the dev default.
pub fn configured_path() -> String {
    std::env::var("TMJLENS_DB_PATH").unwrap_or_else(|_| "data/tmjlens.tmjp".into())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// `None` where the engine reported NULL.
    pub rows: Vec<Vec<Option<String>>>,
}

impl QueryResult {
    /// First column of the first row — the shape of every EXISTS-style probe.
    pub fn single(&self) -> Option<&str> {
        self.rows.first().and_then(|r| r.first()).and_then(|v| v.as_deref())
    }
}

/// Quote a value for inclusion in SQL. The ONLY path a string may take into a
/// statement: doubles single quotes (the engine's escape) and refuses interior
/// NUL bytes, which C strings cannot carry.
pub fn sql_str(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err("value contains a NUL byte, which SQL cannot carry".into());
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

/// `NULL` or the quoted value, for optional columns.
pub fn sql_opt(value: Option<&str>) -> Result<String, String> {
    match value {
        None => Ok("NULL".into()),
        Some(v) => sql_str(v),
    }
}

const SCHEMA: &str = include_str!("../../tools/tmjlite/schema.sql");
const SCHEMA_VERSION: i64 = 4;

/// What upgrades an older database to each version. schema.sql always creates
/// the CURRENT shape, so migrations only run on files born before the change.
/// Statements tolerate partial re-runs ("already exists" is not a failure):
/// a crash between a migration and the version bump must not brick the file.
const MIGRATIONS: &[(i64, &[&str])] = &[
    (
        2,
        &[
            "CREATE TABLE app_settings (id PK, name STRING(100) NOT NULL, value TEXT NOT NULL, updated_at DATETIME DEFAULT(TODAY));",
            "CREATE UNIQUE INDEX idx_app_settings_name ON app_settings (name);",
        ],
    ),
    (
        3,
        &[
            "CREATE TABLE rs_rollup_5m (id PK, namespace STRING(253) NOT NULL, kind STRING(40) NOT NULL, workload STRING(253) NOT NULL, container STRING(253) NOT NULL, window_start STRING(40) NOT NULL, cpu_hist TEXT NOT NULL, mem_hist TEXT NOT NULL, mem_max_bytes STRING(40), samples INT NOT NULL, oom_kills INT NOT NULL, throttle_ratio STRING(32), cpu_request_milli STRING(40), cpu_limit_milli STRING(40), mem_request_bytes STRING(40), mem_limit_bytes STRING(40), replicas INT, limited_data BOOL DEFAULT(FALSE));",
            "CREATE UNIQUE INDEX idx_rs_5m ON rs_rollup_5m (namespace, kind, workload, container, window_start);",
            "CREATE TABLE rs_rollup_1h (id PK, namespace STRING(253) NOT NULL, kind STRING(40) NOT NULL, workload STRING(253) NOT NULL, container STRING(253) NOT NULL, window_start STRING(40) NOT NULL, cpu_hist TEXT NOT NULL, mem_hist TEXT NOT NULL, mem_max_bytes STRING(40), samples INT NOT NULL, oom_kills INT NOT NULL, throttle_ratio STRING(32), cpu_request_milli STRING(40), cpu_limit_milli STRING(40), mem_request_bytes STRING(40), mem_limit_bytes STRING(40), replicas INT, limited_data BOOL DEFAULT(FALSE));",
            "CREATE UNIQUE INDEX idx_rs_1h ON rs_rollup_1h (namespace, kind, workload, container, window_start);",
            "CREATE TABLE rs_rollup_1d (id PK, namespace STRING(253) NOT NULL, kind STRING(40) NOT NULL, workload STRING(253) NOT NULL, container STRING(253) NOT NULL, window_start STRING(40) NOT NULL, cpu_hist TEXT NOT NULL, mem_hist TEXT NOT NULL, mem_max_bytes STRING(40), samples INT NOT NULL, oom_kills INT NOT NULL, throttle_ratio STRING(32), cpu_request_milli STRING(40), cpu_limit_milli STRING(40), mem_request_bytes STRING(40), mem_limit_bytes STRING(40), replicas INT, limited_data BOOL DEFAULT(FALSE));",
            "CREATE UNIQUE INDEX idx_rs_1d ON rs_rollup_1d (namespace, kind, workload, container, window_start);",
            "CREATE TABLE rs_recommendation (id PK, namespace STRING(253) NOT NULL, kind STRING(40) NOT NULL, workload STRING(253) NOT NULL, container STRING(253) NOT NULL, cpu_request_milli STRING(40), mem_request_bytes STRING(40), confidence STRING(16) NOT NULL, days_of_data STRING(16) NOT NULL, reason TEXT NOT NULL, computed_at STRING(40) NOT NULL);",
            "CREATE UNIQUE INDEX idx_rs_rec ON rs_recommendation (namespace, kind, workload, container);",
            "CREATE TABLE hpa_managed (id PK, namespace STRING(253) NOT NULL, name STRING(253) NOT NULL, target_kind STRING(40) NOT NULL, target_name STRING(253) NOT NULL, applied_yaml TEXT NOT NULL, previous_yaml TEXT, applied_at STRING(40) NOT NULL, applied_by STRING(320) NOT NULL);",
            "CREATE UNIQUE INDEX idx_hpa_managed ON hpa_managed (namespace, name);",
            "CREATE TABLE collector_nodes (id PK, node_name STRING(253) NOT NULL, last_seen STRING(40) NOT NULL, limited_data BOOL DEFAULT(FALSE));",
            "CREATE UNIQUE INDEX idx_collector_nodes ON collector_nodes (node_name);",
        ],
    ),
    (
        4,
        &[
            "CREATE TABLE resources_managed (id PK, namespace STRING(253) NOT NULL, kind STRING(40) NOT NULL, name STRING(253) NOT NULL, container STRING(253) NOT NULL, applied_json TEXT NOT NULL, previous_json TEXT, applied_at STRING(40) NOT NULL, applied_by STRING(320) NOT NULL);",
            "CREATE UNIQUE INDEX idx_resources_managed ON resources_managed (namespace, kind, name, container);",
        ],
    ),
];

impl Db {
    /// Open (or create) the database file and bring its schema up to date.
    pub fn open(path: &Path) -> Result<Db, String> {
        let conn = tmjlite::SharedConnection::open(&path.to_string_lossy()).map_err(|e| match e {
            tmjlite::Error::Library(why) => format!(
                "could not load the tmjLite engine: {why}. Set TMJLITE_LIB_PATH to the \
                 libtmjlite_ffi file, or place it next to the executable."
            ),
            tmjlite::Error::Database(_) => format!(
                "could not open {} — if another tmjLens process has it open, stop it first \
                 (tmjLite is one process per file; look for a stale {}.lock)",
                path.display(),
                path.display()
            ),
        })?;
        conn.set_memory_budget(memory_budget()).map_err(err)?;
        // A cursor whose shape the engine cannot stream (joins, subqueries,
        // DISTINCT, ORDER BY or LIMIT over aggregates) fails with the reason
        // instead of materialising behind the same API — the memory profile
        // `fold` exists to forbid must never come back without a sign.
        conn.set_strict_streaming(true).map_err(err)?;
        let db = Db { conn };
        db.ensure_schema()?;
        Ok(db)
    }

    pub fn engine_version(&self) -> String {
        tmjlite::version().unwrap_or_else(|_| "unknown".into())
    }

    /// What the engine holds in RAM for this handle. `None` while another
    /// thread is inside a transaction — said so, not shown as zero.
    pub fn memory_stats(&self) -> Option<tmjlite::MemoryStats> {
        self.conn.memory_stats().ok().flatten()
    }

    /// Run one non-SELECT statement.
    pub fn exec(&self, sql: &str) -> Result<(), String> {
        self.conn.execute(sql).map(|_| ()).map_err(err)
    }

    /// Run one SELECT through a streaming cursor, one row in memory at a
    /// time. This is how every read over the rollup tables must go: a
    /// materialised `query` over a day of history was the production OOM.
    /// Inside a BEGIN on this thread the cursor sees the transaction's own
    /// writes; it is closed before this returns, so WAL checkpoints are never
    /// held up.
    pub fn fold<T>(
        &self,
        sql: &str,
        init: T,
        mut step: impl FnMut(T, &Row<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cursor = self.conn.cursor(sql).map_err(err)?;
        if !cursor.streaming() {
            return Err(format!(
                "this query does not stream through the cursor (joins, subqueries, DISTINCT, \
                 ORDER BY or LIMIT over aggregates are materialised); rewrite it or use query(): {sql}"
            ));
        }
        let mut acc = init;
        while let Some(row) = cursor.next().map_err(err)? {
            acc = step(acc, &Row::new(&row))?;
        }
        Ok(acc)
    }

    /// Run one SELECT and copy the whole result out. Fine for a screen of
    /// users or an audit page; never for the rollup tables — use `fold`.
    pub fn query(&self, sql: &str) -> Result<QueryResult, String> {
        let result = self.conn.query(sql).map_err(err)?;
        let rows = result
            .rows
            .iter()
            .map(|row| row.values().iter().map(|v| cell_text(v).map(Cow::into_owned)).collect())
            .collect();
        Ok(QueryResult { columns: result.columns, rows })
    }

    /// Create the schema on a fresh file; verify the version on an existing
    /// one. Never guesses: a database written by a newer tmjLens is refused.
    fn ensure_schema(&self) -> Result<(), String> {
        match self.query("SELECT version FROM schema_meta;") {
            Ok(meta) => {
                let found: i64 = meta
                    .single()
                    .and_then(|v| v.parse().ok())
                    .ok_or("schema_meta exists but holds no readable version")?;
                if found > SCHEMA_VERSION {
                    return Err(format!(
                        "database schema is v{found}, this build understands v{SCHEMA_VERSION} \
                         — it was written by a newer tmjLens; upgrade this deployment"
                    ));
                }
                for (version, statements) in MIGRATIONS {
                    if *version <= found {
                        continue;
                    }
                    for stmt in *statements {
                        if let Err(error) = self.exec(stmt) {
                            let tolerable = error.contains("already")
                                || error.contains("exists")
                                || error.contains("reused");
                            if !tolerable {
                                return Err(format!(
                                    "migration to schema v{version} failed on `{stmt}`: {error}"
                                ));
                            }
                        }
                    }
                }
                if found < SCHEMA_VERSION {
                    self.exec(&format!("UPDATE schema_meta SET version = {SCHEMA_VERSION};"))?;
                }
                Ok(())
            }
            Err(_) => {
                for stmt in schema_statements() {
                    self.exec(&stmt).map_err(|e| {
                        format!("could not create schema (statement `{stmt}`): {e}")
                    })?;
                }
                self.exec(&format!(
                    "INSERT INTO schema_meta (version) VALUES ({SCHEMA_VERSION});"
                ))
            }
        }
    }
}

/// The REPL and the engine both choke on `--` comments that precede a
/// statement (continuation lines are joined with spaces), so the schema file
/// is stripped to bare statements before execution.
fn schema_statements() -> Vec<String> {
    let bare: String = SCHEMA
        .lines()
        .map(|line| line.split("--").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    bare.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("{s};"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("tmjlens-db-tests");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let unique = format!(
            "{tag}-{}-{}.tmjp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        dir.join(unique)
    }

    #[test]
    fn escaping_doubles_quotes_and_refuses_nul() {
        assert_eq!(sql_str("plain").unwrap(), "'plain'");
        assert_eq!(sql_str("it's").unwrap(), "'it''s'");
        assert_eq!(sql_str("a''b").unwrap(), "'a''''b'");
        assert!(sql_str("a\0b").is_err());
        assert_eq!(sql_opt(None).unwrap(), "NULL");
        assert_eq!(sql_opt(Some("x")).unwrap(), "'x'");
    }

    #[test]
    fn schema_statements_are_bare_and_terminated() {
        let stmts = schema_statements();
        assert!(stmts.len() >= 12, "tables plus indexes, got {}", stmts.len());
        for s in &stmts {
            assert!(!s.contains("--"), "comment leaked into: {s}");
            assert!(s.ends_with(';'));
        }
        assert!(stmts.iter().any(|s| s.contains("CREATE TABLE app_users")));
        assert!(stmts.iter().any(|s| s.contains("CREATE TABLE schema_meta")));
    }

    /// The engine is the tmjlite crate's bundled library; Cargo.lock pins the
    /// crate. The library that actually loads must be that release.
    #[test]
    fn the_engine_is_tmjlite_035() {
        let db = Db::open(&temp_db("engine-version")).expect("open");
        assert!(
            db.engine_version().starts_with("0.3.5"),
            "the loaded engine says {}, the crate is 0.3.5",
            db.engine_version()
        );
    }

    /// The shared handle keeps the tables it wrote in RAM. The budget set at
    /// open is what lets the engine give that memory back.
    #[test]
    fn the_write_cache_is_measured_and_released() {
        let db = Db::open(&temp_db("memory")).expect("open");
        for i in 0..200 {
            db.exec(&format!(
                "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist, mem_hist, \
                 samples, oom_kills) VALUES ('shop', 'Deployment', 'checkout', 'api', \
                 '2026-10-16T{:02}:{:02}:00+00:00', '[]', '[]', 1, 0);",
                i / 12,
                (i % 12) * 5
            ))
            .expect("seed");
        }
        let held = db.memory_stats().expect("no other thread is in a transaction");
        assert!(held.rows >= 200, "the written table is resident: {held:?}");
        db.conn.release_memory().expect("release");
        let after = db.memory_stats().expect("stats");
        assert!(after.total() < held.total(), "release gives memory back: {held:?} -> {after:?}");
    }

    /// The cursor is the only read path allowed over the rollup tables.
    /// This pins its contract: rows arrive in order, NULL is None (not the
    /// string "NULL"), typed accessors read INT/TEXT columns, and a closure
    /// error stops the walk with that error.
    #[test]
    fn fold_streams_rows_with_real_nulls_and_typed_cells() {
        let db = Db::open(&temp_db("fold")).expect("open");
        for (window, samples, req) in [
            ("2026-10-15T10:00:00+00:00", 3, "'250'"),
            ("2026-10-15T10:05:00+00:00", 4, "NULL"),
        ] {
            db.exec(&format!(
                "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist, mem_hist, \
                 samples, oom_kills, cpu_request_milli) VALUES ('shop', 'Deployment', 'checkout', 'api', \
                 '{window}', '[]', '[]', {samples}, 0, {req});"
            ))
            .expect("seed");
        }
        let seen = db
            .fold(
                "SELECT window_start, samples, cpu_request_milli FROM rs_rollup_5m \
                 WHERE namespace = 'shop' AND kind = 'Deployment' AND workload = 'checkout' AND container = 'api' \
                 AND window_start >= '2026-10-15T10:00:00+00:00' AND window_start < '2026-10-15T11:00:00+00:00';",
                Vec::new(),
                |mut acc, row| {
                    acc.push((row.text(0).map(str::to_string), row.i64(1), row.f64(2), row.text(2).map(str::to_string)));
                    Ok(acc)
                },
            )
            .expect("fold");
        assert_eq!(
            seen,
            vec![
                (Some("2026-10-15T10:00:00+00:00".into()), Some(3), Some(250.0), Some("250".into())),
                (Some("2026-10-15T10:05:00+00:00".into()), Some(4), None, None),
            ]
        );

        // The shape merged_usage uses — equality on the index's leading
        // columns plus ORDER BY on its last one — must stream.
        let ordered = db
            .fold(
                "SELECT window_start FROM rs_rollup_5m WHERE namespace = 'shop' AND kind = 'Deployment' \
                 AND workload = 'checkout' AND container = 'api' ORDER BY window_start;",
                0usize,
                |n, _| Ok(n + 1),
            )
            .expect("ORDER BY on the indexed column streams");
        assert_eq!(ordered, 2);
        // A join is materialised behind the same API; fold must refuse it.
        let joined = db.fold(
            "SELECT a.samples FROM rs_rollup_5m a JOIN rs_rollup_1h b ON a.namespace = b.namespace;",
            0usize,
            |n, _| Ok(n + 1),
        );
        assert!(joined.is_err(), "a join must be refused, not materialised: {joined:?}");

        let stopped = db.fold("SELECT samples FROM rs_rollup_5m;", 0, |_, _| Err::<i32, _>("stop here".to_string()));
        assert_eq!(stopped, Err("stop here".to_string()));
        assert!(db.fold("SELECT nope FROM rs_rollup_5m;", 0, |a, _| Ok(a)).is_err(), "a bad column is an error, not zero rows");
    }

    #[test]
    fn open_creates_schema_and_round_trips_values() {
        let path = temp_db("roundtrip");
        let db = Db::open(&path).expect("open");
        assert!(!db.engine_version().is_empty());

        db.exec(&format!(
            "INSERT INTO app_users (email, display_name) VALUES ({}, {});",
            sql_str("tm.jacometti@gmail.com").unwrap(),
            sql_str("Thiago d'Ávila").unwrap(),
        ))
        .expect("insert");

        let got = db
            .query("SELECT email, display_name, idp_subject, active FROM app_users;")
            .expect("select");
        assert_eq!(got.columns, ["email", "display_name", "idp_subject", "active"]);
        assert_eq!(got.rows.len(), 1);
        let row = &got.rows[0];
        assert_eq!(row[0].as_deref(), Some("tm.jacometti@gmail.com"));
        // The quote survived the escape round-trip.
        assert_eq!(row[1].as_deref(), Some("Thiago d'Ávila"));
        // NULL comes back as None, and the BOOL default was applied.
        assert_eq!(row[2], None);
        assert_eq!(row[3].as_deref(), Some("true"));
    }

    #[test]
    fn duplicate_email_is_rejected_by_the_unique_index() {
        let path = temp_db("dup");
        let db = Db::open(&path).expect("open");
        let insert = format!(
            "INSERT INTO app_users (email) VALUES ({});",
            sql_str("someone@tmjsistemas.com.br").unwrap()
        );
        db.exec(&insert).expect("first insert");
        let err = db.exec(&insert).expect_err("second insert must fail");
        assert!(err.contains("unique"), "unexpected error: {err}");
    }

    #[test]
    fn reopening_keeps_data_and_schema_check_is_idempotent() {
        let path = temp_db("reopen");
        {
            let db = Db::open(&path).expect("first open");
            db.exec(&format!(
                "INSERT INTO profiles (name, description) VALUES ({}, NULL);",
                sql_str("viewer").unwrap()
            ))
            .expect("insert");
        }
        // The first handle released the file lock on drop; the second open
        // must see the row and must NOT try to re-create tables.
        let db = Db::open(&path).expect("second open");
        let got = db.query("SELECT name FROM profiles;").expect("select");
        assert_eq!(got.single(), Some("viewer"));
        let meta = db.query("SELECT version FROM schema_meta;").expect("meta");
        assert_eq!(meta.rows.len(), 1, "version row must not duplicate");
    }

    #[test]
    fn an_older_database_is_migrated_forward_on_open() {
        let path = temp_db("migrate");
        {
            let db = Db::open(&path).expect("open");
            // Rewind the version stamp: to the next open this file looks like
            // it was written before app_settings existed. The migration must
            // tolerate the table already being there and re-stamp v2.
            db.exec("UPDATE schema_meta SET version = 1;").expect("rewind");
        }
        let db = Db::open(&path).expect("reopen migrates");
        let meta = db.query("SELECT version FROM schema_meta;").expect("meta");
        assert_eq!(meta.single().map(str::to_string), Some(SCHEMA_VERSION.to_string()));
        db.exec("INSERT INTO app_settings (name, value) VALUES ('probe', '{}');")
            .expect("app_settings usable after migration");
        db.exec("INSERT INTO collector_nodes (node_name, last_seen, limited_data) VALUES ('node-a', '2026-09-01T00:00:00Z', FALSE);")
            .expect("rightsizing tables usable after migration");
    }

    /// tmjLite 0.2.9 gave the shared handle interactive transactions, bound to
    /// the calling thread. The ingest batches hundreds of writes into one
    /// commit on the strength of this — a regression here would silently put
    /// the ~400 ms-per-statement cost back (measured on 0.2.8).
    #[test]
    fn a_transaction_batches_writes_on_the_shared_handle() {
        let path = temp_db("txn");
        let db = Db::open(&path).expect("open");
        db.exec("CREATE TABLE txn_probe (id PK, n INT NOT NULL);").expect("table");

        db.exec("BEGIN;").expect("shared handle accepts BEGIN since engine 0.2.9");
        for i in 0..20 {
            db.exec(&format!("INSERT INTO txn_probe (n) VALUES ({i});")).expect("insert inside txn");
        }
        db.exec("COMMIT;").expect("commit");
        let count = db.query("SELECT COUNT(*) FROM txn_probe;").expect("count");
        assert_eq!(count.single(), Some("20"), "all rows visible after COMMIT");

        db.exec("BEGIN;").expect("begin");
        db.exec("INSERT INTO txn_probe (n) VALUES (99);").expect("insert");
        db.exec("ROLLBACK;").expect("rollback");
        let count = db.query("SELECT COUNT(*) FROM txn_probe;").expect("count");
        assert_eq!(count.single(), Some("20"), "ROLLBACK discards the uncommitted row");
    }

    #[test]
    fn a_malicious_literal_stays_a_literal() {
        let path = temp_db("inject");
        let db = Db::open(&path).expect("open");
        let sneaky = "x'); DELETE FROM app_users; --";
        db.exec(&format!(
            "INSERT INTO app_users (email) VALUES ({});",
            sql_str(sneaky).unwrap()
        ))
        .expect("insert");
        let got = db.query("SELECT email FROM app_users;").expect("select");
        // Stored verbatim: the payload never became SQL.
        assert_eq!(got.single(), Some(sneaky));
    }
}
