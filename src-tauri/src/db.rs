//! tmjLite behind a thread-safe handle: users, profiles, permissions and the
//! audit log live in one `.tmjp` file on the pod's volume.
//!
//! The engine is loaded at runtime (`tmjlite_ffi.dll` / `libtmjlite_ffi.so`)
//! rather than linked, so the same source builds on the Windows dev box and in
//! the Linux container without platform link plumbing. Everything goes through
//! `tmjlite_open_shared`: SELECTs run on MVCC snapshots in parallel, writes
//! serialize inside the engine and are durable when the call returns, and each
//! statement auto-commits — which is exactly the shape an HTTP server wants.
//!
//! tmjLite has no bind parameters over FFI: every value reaches SQL as a
//! quoted literal. Nothing may interpolate a raw string into SQL — it must go
//! through [`sql_str`], which doubles quotes the way the engine expects.

use std::ffi::{c_char, c_int, CStr, CString};
use std::path::{Path, PathBuf};

type OpenSharedFn = unsafe extern "C" fn(*const c_char) -> *mut std::ffi::c_void;
type CloseSharedFn = unsafe extern "C" fn(*mut std::ffi::c_void);
type ExecSharedFn = unsafe extern "C" fn(*const std::ffi::c_void, *const c_char) -> c_int;
type QuerySharedFn =
    unsafe extern "C" fn(*const std::ffi::c_void, *const c_char) -> *mut std::ffi::c_void;
type ErrmsgSharedFn = unsafe extern "C" fn(*const std::ffi::c_void) -> *const c_char;
type ResultCountFn = unsafe extern "C" fn(*const std::ffi::c_void) -> c_int;
type ResultNameFn = unsafe extern "C" fn(*const std::ffi::c_void, c_int) -> *const c_char;
type ResultValueFn = unsafe extern "C" fn(*const std::ffi::c_void, c_int, c_int) -> *const c_char;
type ResultFreeFn = unsafe extern "C" fn(*mut std::ffi::c_void);
type VersionFn = unsafe extern "C" fn() -> *const c_char;

struct Api {
    open_shared: OpenSharedFn,
    close_shared: CloseSharedFn,
    exec_shared: ExecSharedFn,
    query_shared: QuerySharedFn,
    errmsg_shared: ErrmsgSharedFn,
    column_count: ResultCountFn,
    column_name: ResultNameFn,
    row_count: ResultCountFn,
    value: ResultValueFn,
    result_free: ResultFreeFn,
    version: VersionFn,
}

pub struct Db {
    api: Api,
    handle: *mut std::ffi::c_void,
    // Dropped last (field order): the fn pointers in `api` live inside it.
    _lib: libloading::Library,
}

// The header's contract for the shared handle: one handle, N threads, reads on
// parallel snapshots, writes serialized internally. errmsg is thread-local.
unsafe impl Send for Db {}
unsafe impl Sync for Db {}

impl Drop for Db {
    fn drop(&mut self) {
        unsafe { (self.api.close_shared)(self.handle) };
    }
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
const SCHEMA_VERSION: i64 = 1;

/// The engine library ships in-repo under tools/tmjlite. Resolution order:
/// explicit env override, next to the executable, the working directory, then
/// the repo layout (also two levels up, which is where `cargo test` runs from).
fn library_path() -> PathBuf {
    if let Ok(path) = std::env::var("TMJLITE_FFI_PATH") {
        return PathBuf::from(path);
    }
    let name = if cfg!(target_os = "windows") {
        "tmjlite_ffi.dll"
    } else if cfg!(target_os = "macos") {
        "libtmjlite_ffi.dylib"
    } else {
        "libtmjlite_ffi.so"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(name));
        candidates.push(cwd.join("tools").join("tmjlite").join(name));
        candidates.push(cwd.join("..").join("tools").join("tmjlite").join(name));
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(name))
}

impl Db {
    /// Open (or create) the database file and bring its schema up to date.
    pub fn open(path: &Path) -> Result<Db, String> {
        let lib_path = library_path();
        let lib = unsafe { libloading::Library::new(&lib_path) }.map_err(|e| {
            format!(
                "could not load the tmjLite engine from {}: {e}. Set TMJLITE_FFI_PATH \
                 or place the library next to the executable.",
                lib_path.display()
            )
        })?;
        let api = unsafe {
            Api {
                open_shared: *lib.get(b"tmjlite_open_shared\0").map_err(err_sym)?,
                close_shared: *lib.get(b"tmjlite_close_shared\0").map_err(err_sym)?,
                exec_shared: *lib.get(b"tmjlite_exec_shared\0").map_err(err_sym)?,
                query_shared: *lib.get(b"tmjlite_query_shared\0").map_err(err_sym)?,
                errmsg_shared: *lib.get(b"tmjlite_errmsg_shared\0").map_err(err_sym)?,
                column_count: *lib.get(b"tmjlite_result_column_count\0").map_err(err_sym)?,
                column_name: *lib.get(b"tmjlite_result_column_name\0").map_err(err_sym)?,
                row_count: *lib.get(b"tmjlite_result_row_count\0").map_err(err_sym)?,
                value: *lib.get(b"tmjlite_result_value\0").map_err(err_sym)?,
                result_free: *lib.get(b"tmjlite_result_free\0").map_err(err_sym)?,
                version: *lib.get(b"tmjlite_version\0").map_err(err_sym)?,
            }
        };
        let c_path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "database path contains a NUL byte".to_string())?;
        let handle = unsafe { (api.open_shared)(c_path.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "could not open {} — if another tmjLens process has it open, stop it first \
                 (tmjLite is one process per file; look for a stale {}.lock)",
                path.display(),
                path.display()
            ));
        }
        let db = Db { api, handle, _lib: lib };
        db.ensure_schema()?;
        Ok(db)
    }

    pub fn engine_version(&self) -> String {
        let ptr = unsafe { (self.api.version)() };
        read_str(ptr).unwrap_or_else(|| "unknown".into())
    }

    fn last_error(&self) -> String {
        let ptr = unsafe { (self.api.errmsg_shared)(self.handle) };
        read_str(ptr).unwrap_or_else(|| "unknown tmjLite error".into())
    }

    /// Run one non-SELECT statement.
    pub fn exec(&self, sql: &str) -> Result<(), String> {
        let c_sql =
            CString::new(sql).map_err(|_| "statement contains a NUL byte".to_string())?;
        let rc = unsafe { (self.api.exec_shared)(self.handle, c_sql.as_ptr()) };
        if rc == 0 { Ok(()) } else { Err(self.last_error()) }
    }

    /// Run one SELECT and copy the whole result out.
    pub fn query(&self, sql: &str) -> Result<QueryResult, String> {
        let c_sql =
            CString::new(sql).map_err(|_| "statement contains a NUL byte".to_string())?;
        let raw = unsafe { (self.api.query_shared)(self.handle, c_sql.as_ptr()) };
        if raw.is_null() {
            return Err(self.last_error());
        }
        let result = unsafe {
            let cols = (self.api.column_count)(raw).max(0);
            let rows = (self.api.row_count)(raw).max(0);
            let mut columns = Vec::with_capacity(cols as usize);
            for c in 0..cols {
                columns.push(read_str((self.api.column_name)(raw, c)).unwrap_or_default());
            }
            let mut data = Vec::with_capacity(rows as usize);
            for r in 0..rows {
                let mut row = Vec::with_capacity(cols as usize);
                for c in 0..cols {
                    let cell = read_str((self.api.value)(raw, r, c));
                    // The FFI spells NULL as the string "NULL"; every real
                    // string in a result was quoted on the way in, so nothing
                    // legitimate collides with it in our schema.
                    row.push(cell.filter(|v| v != "NULL"));
                }
                data.push(row);
            }
            (self.api.result_free)(raw);
            QueryResult { columns, rows: data }
        };
        Ok(result)
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
                // found == SCHEMA_VERSION: nothing to do. Migrations from
                // older versions get added here when v2 exists.
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

fn err_sym(e: libloading::Error) -> String {
    format!("tmjLite engine library is missing a symbol: {e}")
}

fn read_str(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
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
            sql_str("someone@mds.com").unwrap()
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
