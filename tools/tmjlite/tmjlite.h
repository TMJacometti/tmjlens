/*
 * TMJLite C API
 * Cross-platform embedded database engine
 *
 * Usage:
 *   TmjDb *db = tmjlite_open("mydb.tmjdb");  // or tmjlite_open_memory()
 *   tmjlite_exec(db, "CREATE TABLE t (x INT);");
 *   TmjResult *r = tmjlite_query(db, "SELECT * FROM t;");
 *   // ... read results ...
 *   tmjlite_result_free(r);
 *   tmjlite_close(db);
 */

#ifndef TMJLITE_H
#define TMJLITE_H

#ifdef __cplusplus
extern "C" {
#endif

/* Error codes */
#define TMJLITE_OK    0
#define TMJLITE_ERROR 1

/* Opaque handles */
typedef struct TmjDb TmjDb;
typedef struct TmjResult TmjResult;

/* ---- Lifecycle ---- */

/* Open a database file. Creates the file if it doesn't exist. */
TmjDb *tmjlite_open(const char *path);

/* Create an in-memory database (no file, data lost on close). */
TmjDb *tmjlite_open_memory(void);

/* Close the database and free all resources. */
void tmjlite_close(TmjDb *db);

/* ---- Execute ---- */

/* Execute a non-query SQL statement (CREATE, INSERT, UPDATE, DELETE, ALTER, BEGIN, COMMIT, ROLLBACK).
 * Returns TMJLITE_OK on success, TMJLITE_ERROR on failure.
 * On error, call tmjlite_errmsg() for details. */
int tmjlite_exec(TmjDb *db, const char *sql);

/* Execute any SQL statement and get the result.
 * For SELECT: returns a result with columns and rows.
 * For non-SELECT: returns a result with a message (0 columns, 0 rows).
 * Returns NULL on error — call tmjlite_errmsg() for details.
 * Caller must free the result with tmjlite_result_free(). */
TmjResult *tmjlite_query(TmjDb *db, const char *sql);

/* ---- Result accessors ---- */

/* Number of columns in the result. */
int tmjlite_result_column_count(const TmjResult *result);

/* Column name at the given index. Returns NULL if out of bounds.
 * The returned pointer is valid until tmjlite_result_free(). */
const char *tmjlite_result_column_name(const TmjResult *result, int index);

/* Number of rows in the result. */
int tmjlite_result_row_count(const TmjResult *result);

/* Value at (row, col) as a string. Returns NULL if out of bounds.
 * NULL values are returned as the string "NULL".
 * The returned pointer is valid until tmjlite_result_free(). */
const char *tmjlite_result_value(const TmjResult *result, int row, int col);

/* Message for non-SELECT results (e.g. "Table 'users' created.").
 * Returns NULL if the result is a SELECT query.
 * The returned pointer is valid until tmjlite_result_free(). */
const char *tmjlite_result_message(const TmjResult *result);

/* Free a result returned by tmjlite_query(). */
void tmjlite_result_free(TmjResult *result);

/* ---- Error ---- */

/* Last error message, or NULL if no error.
 * The returned pointer is valid until the next call on this db. */
const char *tmjlite_errmsg(const TmjDb *db);

/* ---- Save ---- */

/* Explicitly save the database to its file. Returns TMJLITE_ERROR if no path is set. */
int tmjlite_save(TmjDb *db);

/* Save the database to a new path (sets it as the default path). */
int tmjlite_save_as(TmjDb *db, const char *path);

/* ---- Shared (thread-safe) API ---- */

/* Opaque handle for the thread-safe connection (MVCC): one handle may be used
 * from N threads concurrently — SELECTs run on parallel snapshots, writes
 * serialize internally and are durable when the call returns. Each statement
 * auto-commits (BEGIN/COMMIT are rejected on this handle).
 * Cross-process access stays exclusive: opening a file another process holds
 * fails and returns NULL. */
typedef struct TmjSharedDb TmjSharedDb;

/* Open (or create) a database file for shared, thread-safe use.
 * Returns NULL on failure (e.g. locked by another process). */
TmjSharedDb *tmjlite_open_shared(const char *path);

/* Close the shared handle and release the file lock. */
void tmjlite_close_shared(TmjSharedDb *db);

/* Execute a non-query statement. Thread-safe. */
int tmjlite_exec_shared(const TmjSharedDb *db, const char *sql);

/* Execute any statement and get the result. Thread-safe.
 * Caller must free the result with tmjlite_result_free(). */
TmjResult *tmjlite_query_shared(const TmjSharedDb *db, const char *sql);

/* Last error message for the calling thread, or NULL.
 * The pointer stays valid for this thread until its next call. */
const char *tmjlite_errmsg_shared(const TmjSharedDb *db);

/* ---- Shadow (git-merge) API ---- */

/* Shadow session (RFC GIT_MERGE): snapshot of the main file + overlay of this
 * session's own writes; DML statements become row ops in a `.tmjv` sidecar;
 * commit merges them into the main file (LWW by PK, atomic per session).
 * N sessions/processes coexist on the same file. Handle is single-thread. */
typedef struct TmjShadow TmjShadow;

/* Open a shadow session. NULL on failure. */
TmjShadow *tmjlite_shadow_open(const char *path);

/* Close the session. Uncommitted ops stay in the .tmjv (mergeable later). */
void tmjlite_shadow_close(TmjShadow *db);

/* Execute a DML/SELECT statement (DDL and transactions are rejected). */
int tmjlite_shadow_exec(TmjShadow *db, const char *sql);

/* Execute and get the result (sees main snapshot + own writes).
 * Caller must free with tmjlite_result_free(). */
TmjResult *tmjlite_shadow_query(TmjShadow *db, const char *sql);

/* Merge this session's ops into the main file. Returns the number of ops
 * applied (>= 0) or -1 on error/conflict (ops are preserved on conflict). */
long long tmjlite_shadow_commit(TmjShadow *db);

/* Re-snapshot the main file, keeping this session's uncommitted writes. */
int tmjlite_shadow_refresh(TmjShadow *db);

/* Number of ops logged and not yet merged (-1 on bad handle). */
long long tmjlite_shadow_pending(const TmjShadow *db);

/* ---- Named branches (RFC GIT_MERGE M5) ---- */

/* Open (or create) a persistent named branch: <db>.shadows/<name>.tmjb.
 * Same handle/API as a shadow session; SQL becomes branch ops. Only SEALED
 * ops are merged by tmjlite_shadow_commit(), which then consumes the branch
 * (unsealed ops after the last seal make commit fail). NULL on failure. */
TmjShadow *tmjlite_shadow_open_branch(const char *path, const char *name);

/* Seal the unsealed ops of a branch as a commit (author/message stored in
 * the branch log). Returns the number of ops sealed, or -1 on error. */
long long tmjlite_shadow_seal(TmjShadow *db, const char *author, const char *message);

/* Ops logged after the last seal (0 for anonymous shadows; -1 on bad handle). */
long long tmjlite_shadow_unsealed(const TmjShadow *db);

/* Conflict policy for commit (RFC GIT_MERGE M4). policy is one of
 * "lww" (default: shadow wins), "error" (any conflict aborts the whole
 * merge, .tmjv kept), "field_merge" (3-way per column; same column edited on
 * both sides aborts), "manual" (clean rows applied, conflicting ops
 * quarantined in a sibling .tmjc for human resolution).
 * table NULL sets the session default; otherwise overrides that table only. */
int tmjlite_shadow_set_merge_policy(TmjShadow *db, const char *table, const char *policy);

/* Dry-run: number of conflicts commit would hit right now (-1 on error).
 * When > 0, tmjlite_shadow_errmsg() lists them, one per line. */
long long tmjlite_shadow_conflicts(TmjShadow *db);

/* Last error message, or NULL. Valid until the next call on this handle. */
const char *tmjlite_shadow_errmsg(const TmjShadow *db);

/* ---- Version ---- */

/* Returns the library version string (e.g. "0.1.0-capivara"). */
const char *tmjlite_version(void);

#ifdef __cplusplus
}
#endif

#endif /* TMJLITE_H */
