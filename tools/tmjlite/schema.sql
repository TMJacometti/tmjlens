-- tmjLens web — tmjLite schema (v1)
--
-- The server applies this on boot (idempotently); this file exists so the same
-- schema can be created or inspected by hand with the CLI:
--
--     tools/tmjlite/tmjlite.exe data/tmjlens.tmjp   (or ./tmjlite-linux in the pod)
--
-- Identity comes from SSO; nobody has a password here, so there are no HASH
-- columns. A user's row is created on first login with NO profiles (default
-- deny). The first admin is granted by matching TMJLENS_BOOTSTRAP_ADMIN at
-- login time. PK columns are auto-generated UUIDs and are omitted from INSERTs.

-- Bumped whenever this file changes shape; the server refuses a database
-- written by a NEWER tmjLens instead of guessing at columns it does not know.
CREATE TABLE schema_meta (
    id PK,
    version INT NOT NULL,
    applied_at DATETIME DEFAULT(TODAY)
);

CREATE TABLE app_users (
    id PK,
    email STRING(320) NOT NULL,
    display_name STRING(200),
    idp_subject STRING(255),
    active BOOL DEFAULT(TRUE),
    created_at DATETIME DEFAULT(TODAY),
    last_login_at DATETIME
);
CREATE UNIQUE INDEX idx_users_email ON app_users (email);

CREATE TABLE profiles (
    id PK,
    name STRING(100) NOT NULL,
    description STRING(500),
    created_at DATETIME DEFAULT(TODAY)
);
CREATE UNIQUE INDEX idx_profiles_name ON profiles (name);

-- One row per permission a profile grants. The permission catalogue (which
-- strings are valid) lives in Rust; unknown strings are simply never matched.
CREATE TABLE profile_permissions (
    id PK,
    profile_id STRING(36) NOT NULL,
    permission STRING(100) NOT NULL
);
CREATE UNIQUE INDEX idx_profile_perms ON profile_permissions (profile_id, permission);

CREATE TABLE user_profiles (
    id PK,
    user_id STRING(36) NOT NULL,
    profile_id STRING(36) NOT NULL,
    granted_by_email STRING(320),
    granted_at DATETIME DEFAULT(TODAY)
);
CREATE UNIQUE INDEX idx_user_profiles ON user_profiles (user_id, profile_id);

-- The cluster audit log will only ever name the ServiceAccount; this table is
-- the record of WHICH PERSON did each thing. Denied attempts are logged too
-- (allowed = FALSE) — that is half the point of the table.
CREATE TABLE audit_log (
    id PK,
    at DATETIME DEFAULT(TODAY),
    user_email STRING(320) NOT NULL,
    action STRING(100) NOT NULL,
    target STRING(500),
    namespace STRING(253),
    detail TEXT,
    allowed BOOL NOT NULL
);
CREATE INDEX idx_audit_email ON audit_log (user_email);
CREATE INDEX idx_audit_at ON audit_log (at);
