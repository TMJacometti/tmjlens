-- tmjLens web — tmjLite schema (v3)
--
-- The server applies this on boot (idempotently); this file exists so the same
-- schema can be created or inspected by hand with the CLI:
--
--     tools/tmjlite/tmjlite.exe data/tmjlens.tmjp   (or ./tmjlite-linux in the pod)
--
-- Identity comes from SSO; nobody has a password here, so there are no HASH
-- columns. A user's row is created on first login and granted the guest
-- profile. The first admin is granted by matching TMJLENS_BOOTSTRAP_ADMIN at
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

-- Instance-wide app settings (environment tags and the like), one JSON blob
-- per named slot. Added in schema v2.
CREATE TABLE app_settings (
    id PK,
    name STRING(100) NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT(TODAY)
);
CREATE UNIQUE INDEX idx_app_settings_name ON app_settings (name);

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

-- Rightsizing rollups. Histograms are JSON arrays of bucket counts. Identity
-- is namespace+kind+workload+container — never the pod name.
CREATE TABLE rs_rollup_5m (
    id PK,
    namespace STRING(253) NOT NULL,
    kind STRING(40) NOT NULL,
    workload STRING(253) NOT NULL,
    container STRING(253) NOT NULL,
    window_start STRING(40) NOT NULL,
    cpu_hist TEXT NOT NULL,
    mem_hist TEXT NOT NULL,
    mem_max_bytes STRING(40),
    samples INT NOT NULL,
    oom_kills INT NOT NULL,
    throttle_ratio STRING(32),
    cpu_request_milli STRING(40),
    cpu_limit_milli STRING(40),
    mem_request_bytes STRING(40),
    mem_limit_bytes STRING(40),
    replicas INT,
    limited_data BOOL DEFAULT(FALSE)
);
CREATE UNIQUE INDEX idx_rs_5m ON rs_rollup_5m (namespace, kind, workload, container, window_start);

CREATE TABLE rs_rollup_1h (
    id PK,
    namespace STRING(253) NOT NULL,
    kind STRING(40) NOT NULL,
    workload STRING(253) NOT NULL,
    container STRING(253) NOT NULL,
    window_start STRING(40) NOT NULL,
    cpu_hist TEXT NOT NULL,
    mem_hist TEXT NOT NULL,
    mem_max_bytes STRING(40),
    samples INT NOT NULL,
    oom_kills INT NOT NULL,
    throttle_ratio STRING(32),
    cpu_request_milli STRING(40),
    cpu_limit_milli STRING(40),
    mem_request_bytes STRING(40),
    mem_limit_bytes STRING(40),
    replicas INT,
    limited_data BOOL DEFAULT(FALSE)
);
CREATE UNIQUE INDEX idx_rs_1h ON rs_rollup_1h (namespace, kind, workload, container, window_start);

CREATE TABLE rs_rollup_1d (
    id PK,
    namespace STRING(253) NOT NULL,
    kind STRING(40) NOT NULL,
    workload STRING(253) NOT NULL,
    container STRING(253) NOT NULL,
    window_start STRING(40) NOT NULL,
    cpu_hist TEXT NOT NULL,
    mem_hist TEXT NOT NULL,
    mem_max_bytes STRING(40),
    samples INT NOT NULL,
    oom_kills INT NOT NULL,
    throttle_ratio STRING(32),
    cpu_request_milli STRING(40),
    cpu_limit_milli STRING(40),
    mem_request_bytes STRING(40),
    mem_limit_bytes STRING(40),
    replicas INT,
    limited_data BOOL DEFAULT(FALSE)
);
CREATE UNIQUE INDEX idx_rs_1d ON rs_rollup_1d (namespace, kind, workload, container, window_start);

CREATE TABLE rs_recommendation (
    id PK,
    namespace STRING(253) NOT NULL,
    kind STRING(40) NOT NULL,
    workload STRING(253) NOT NULL,
    container STRING(253) NOT NULL,
    cpu_request_milli STRING(40),
    mem_request_bytes STRING(40),
    confidence STRING(16) NOT NULL,
    days_of_data STRING(16) NOT NULL,
    reason TEXT NOT NULL,
    computed_at STRING(40) NOT NULL
);
CREATE UNIQUE INDEX idx_rs_rec ON rs_recommendation (namespace, kind, workload, container);

CREATE TABLE hpa_managed (
    id PK,
    namespace STRING(253) NOT NULL,
    name STRING(253) NOT NULL,
    target_kind STRING(40) NOT NULL,
    target_name STRING(253) NOT NULL,
    applied_yaml TEXT NOT NULL,
    previous_yaml TEXT,
    applied_at STRING(40) NOT NULL,
    applied_by STRING(320) NOT NULL
);
CREATE UNIQUE INDEX idx_hpa_managed ON hpa_managed (namespace, name);

CREATE TABLE collector_nodes (
    id PK,
    node_name STRING(253) NOT NULL,
    last_seen STRING(40) NOT NULL,
    limited_data BOOL DEFAULT(FALSE)
);
CREATE UNIQUE INDEX idx_collector_nodes ON collector_nodes (node_name);
