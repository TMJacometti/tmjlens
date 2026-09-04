//! Who may do what. The ServiceAccount can do everything, so this module is
//! the actual security boundary of the web version: identity comes from SSO,
//! authorization lives here, and every decision — allowed or denied — lands in
//! the audit log, because the cluster's own audit trail will only ever name
//! the ServiceAccount.
//!
//! First login registers the user with NO permissions (default deny). The one
//! exception is `TMJLENS_BOOTSTRAP_ADMIN`: the email it names is granted the
//! admin profile on login, which is how the first admin exists at all.

use crate::db::{sql_opt, sql_str, Db};
use std::collections::HashSet;

/// Everything a profile may grant. The strings are what the database stores;
/// the descriptions exist for the admin screen. Deny is the absence of a row,
/// so an unknown string in the database grants nothing.
pub const PERMISSIONS: &[(&str, &str)] = &[
    ("view", "See workloads, namespaces, storage, reports and plugin screens"),
    ("view-secrets", "Reveal Secret values and ConfigMap contents"),
    ("view-logs", "Read pod logs"),
    ("exec-pods", "Open a shell inside pods"),
    ("port-forward", "Forward cluster ports to the browser"),
    ("edit-yaml", "Edit any object as YAML"),
    ("edit-config", "Add, change and remove ConfigMap and Secret keys"),
    ("scale-workloads", "Scale and rollout-restart controllers"),
    ("delete-workloads", "Delete deployments, pods and other workloads"),
    ("manage-helm", "Uninstall and roll back Helm releases"),
    ("manage-velero", "Create backups and restores"),
    ("manage-argo", "Edit and submit Argo workflows, images, resources, schedules"),
    ("manage-nodes", "Cordon, drain and delete nodes"),
    ("admin", "Manage users, profiles and permissions"),
];

pub fn is_known_permission(name: &str) -> bool {
    PERMISSIONS.iter().any(|(p, _)| *p == name)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub active: bool,
    pub profiles: Vec<String>,
    pub permissions: Vec<String>,
}

fn now_stamp() -> String {
    // tmjLite's DATETIME format: milliseconds joined with ':'.
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S:%3f").to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserSummary {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub active: bool,
    pub last_login_at: Option<String>,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
}

pub struct AuthStore<'a> {
    db: &'a Db,
}

impl<'a> AuthStore<'a> {
    /// Wraps an open database and guarantees the seed profiles exist:
    /// `admin` holding every permission and `viewer` holding read-only ones.
    /// Seeds are only planted when the profiles table is empty, so renaming
    /// or trimming them later sticks.
    pub fn new(db: &'a Db) -> Result<AuthStore<'a>, String> {
        let store = AuthStore::attach(db);
        let existing = db.query("SELECT name FROM profiles;")?;
        if existing.rows.is_empty() {
            let admin = store.create_profile(
                "admin",
                Some("Full control, including user management"),
            )?;
            for (perm, _) in PERMISSIONS {
                store.add_permission(&admin, perm)?;
            }
            let viewer =
                store.create_profile("viewer", Some("Read-only: screens and logs"))?;
            store.add_permission(&viewer, "view")?;
            store.add_permission(&viewer, "view-logs")?;
        }
        Ok(store)
    }

    /// A view over an already-seeded database — the per-request constructor.
    pub fn attach(db: &'a Db) -> AuthStore<'a> {
        AuthStore { db }
    }

    /// The login path. Registers an unknown email with zero access, refreshes
    /// the known one, refuses a deactivated one, and applies the bootstrap
    /// admin grant when the environment names this email.
    pub fn register_login(
        &self,
        email: &str,
        display_name: Option<&str>,
        idp_subject: Option<&str>,
    ) -> Result<UserRecord, String> {
        let email = email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return Err("login without a usable email address".into());
        }
        let found = self.db.query(&format!(
            "SELECT id, active FROM app_users WHERE email = {};",
            sql_str(&email)?
        ))?;
        let user_id = match found.rows.first() {
            Some(row) => {
                let id = row[0].clone().ok_or("user row without id")?;
                if row[1].as_deref() != Some("true") {
                    self.audit(&email, "login", None, None, Some("account is deactivated"), false)?;
                    return Err(format!("{email} is deactivated; ask an admin to re-enable it"));
                }
                self.db.exec(&format!(
                    "UPDATE app_users SET last_login_at = {}, display_name = {} WHERE id = {};",
                    sql_str(&now_stamp())?,
                    sql_opt(display_name)?,
                    sql_str(&id)?
                ))?;
                id
            }
            None => {
                self.db.exec(&format!(
                    "INSERT INTO app_users (email, display_name, idp_subject, last_login_at) \
                     VALUES ({}, {}, {}, {});",
                    sql_str(&email)?,
                    sql_opt(display_name)?,
                    sql_opt(idp_subject)?,
                    sql_str(&now_stamp())?
                ))?;
                self.audit(&email, "first-login-registered", None, None,
                    Some("registered with no permissions (default deny)"), true)?;
                self.user_id_by_email(&email)?
                    .ok_or("user vanished right after registration")?
            }
        };

        if let Ok(bootstrap) = std::env::var("TMJLENS_BOOTSTRAP_ADMIN") {
            if bootstrap.trim().to_lowercase() == email {
                if let Some(admin_id) = self.profile_id_by_name("admin")? {
                    if self.grant_profile(&user_id, &admin_id, "bootstrap")? {
                        self.audit(&email, "bootstrap-admin-granted", None, None,
                            Some("email matches TMJLENS_BOOTSTRAP_ADMIN"), true)?;
                    }
                }
            }
        }

        self.load_user(&user_id)
    }

    pub fn load_user(&self, user_id: &str) -> Result<UserRecord, String> {
        let row = self
            .db
            .query(&format!(
                "SELECT id, email, display_name, active FROM app_users WHERE id = {};",
                sql_str(user_id)?
            ))?
            .rows
            .into_iter()
            .next()
            .ok_or_else(|| format!("no user with id {user_id}"))?;
        let mut profiles = Vec::new();
        let mut permissions = HashSet::new();
        for pid in self.profile_ids_for(user_id)? {
            if let Some(name) = self.profile_name(&pid)? {
                profiles.push(name);
            }
            for perm in self.permissions_of(&pid)? {
                permissions.insert(perm);
            }
        }
        profiles.sort();
        let mut permissions: Vec<String> = permissions.into_iter().collect();
        permissions.sort();
        Ok(UserRecord {
            id: row[0].clone().unwrap_or_default(),
            email: row[1].clone().unwrap_or_default(),
            display_name: row[2].clone(),
            active: row[3].as_deref() == Some("true"),
            profiles,
            permissions,
        })
    }

    /// The one question the request path asks. Admins hold every permission
    /// implicitly, so a profile does not need all rows to run the shop.
    pub fn allows(&self, user: &UserRecord, permission: &str) -> bool {
        user.active
            && (user.permissions.iter().any(|p| p == permission)
                || user.permissions.iter().any(|p| p == "admin"))
    }

    // ---- administration ----

    pub fn create_profile(&self, name: &str, description: Option<&str>) -> Result<String, String> {
        self.db.exec(&format!(
            "INSERT INTO profiles (name, description) VALUES ({}, {});",
            sql_str(name)?,
            sql_opt(description)?
        ))?;
        self.profile_id_by_name(name)?
            .ok_or("profile vanished right after creation".into())
    }

    pub fn add_permission(&self, profile_id: &str, permission: &str) -> Result<(), String> {
        if !is_known_permission(permission) {
            return Err(format!("'{permission}' is not a permission tmjLens knows"));
        }
        match self.db.exec(&format!(
            "INSERT INTO profile_permissions (profile_id, permission) VALUES ({}, {});",
            sql_str(profile_id)?,
            sql_str(permission)?
        )) {
            Ok(()) => Ok(()),
            // Granting what is already granted is not an error worth surfacing.
            Err(e) if e.contains("unique") => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn remove_permission(&self, profile_id: &str, permission: &str) -> Result<(), String> {
        self.db.exec(&format!(
            "DELETE FROM profile_permissions WHERE profile_id = {} AND permission = {};",
            sql_str(profile_id)?,
            sql_str(permission)?
        ))
    }

    /// Returns whether the grant was new (false: it already existed).
    pub fn grant_profile(
        &self,
        user_id: &str,
        profile_id: &str,
        granted_by_email: &str,
    ) -> Result<bool, String> {
        match self.db.exec(&format!(
            "INSERT INTO user_profiles (user_id, profile_id, granted_by_email) \
             VALUES ({}, {}, {});",
            sql_str(user_id)?,
            sql_str(profile_id)?,
            sql_str(granted_by_email)?
        )) {
            Ok(()) => Ok(true),
            Err(e) if e.contains("unique") => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn revoke_profile(&self, user_id: &str, profile_id: &str) -> Result<(), String> {
        self.db.exec(&format!(
            "DELETE FROM user_profiles WHERE user_id = {} AND profile_id = {};",
            sql_str(user_id)?,
            sql_str(profile_id)?
        ))
    }

    pub fn set_user_active(&self, user_id: &str, active: bool) -> Result<(), String> {
        self.db.exec(&format!(
            "UPDATE app_users SET active = {} WHERE id = {};",
            if active { "TRUE" } else { "FALSE" },
            sql_str(user_id)?
        ))
    }

    // ---- administration listings ----

    pub fn list_users(&self) -> Result<Vec<UserSummary>, String> {
        let rows = self
            .db
            .query("SELECT id, email, display_name, active, last_login_at FROM app_users;")?;
        let mut users = Vec::new();
        for row in rows.rows {
            let id = row[0].clone().unwrap_or_default();
            let mut profiles = Vec::new();
            for pid in self.profile_ids_for(&id)? {
                if let Some(name) = self.profile_name(&pid)? {
                    profiles.push(name);
                }
            }
            profiles.sort();
            users.push(UserSummary {
                id,
                email: row[1].clone().unwrap_or_default(),
                display_name: row[2].clone(),
                active: row[3].as_deref() == Some("true"),
                last_login_at: row[4].clone(),
                profiles,
            });
        }
        users.sort_by(|a, b| a.email.cmp(&b.email));
        Ok(users)
    }

    pub fn list_profiles(&self) -> Result<Vec<ProfileSummary>, String> {
        let rows = self.db.query("SELECT id, name, description FROM profiles;")?;
        let mut profiles = Vec::new();
        for row in rows.rows {
            let id = row[0].clone().unwrap_or_default();
            let mut permissions = self.permissions_of(&id)?;
            permissions.sort();
            profiles.push(ProfileSummary {
                id,
                name: row[1].clone().unwrap_or_default(),
                description: row[2].clone(),
                permissions,
            });
        }
        profiles.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(profiles)
    }

    /// Newest first. tmjLite's DATETIME strings sort lexicographically in
    /// chronological order, so when the engine cannot ORDER BY the rows are
    /// sorted here instead — same answer either way.
    pub fn recent_audit(&self, limit: usize) -> Result<crate::db::QueryResult, String> {
        const COLUMNS: &str = "at, user_email, action, target, namespace, detail, allowed";
        match self.db.query(&format!(
            "SELECT {COLUMNS} FROM audit_log ORDER BY at DESC LIMIT {limit};"
        )) {
            Ok(result) => Ok(result),
            Err(_) => {
                let mut result = self.db.query(&format!("SELECT {COLUMNS} FROM audit_log;"))?;
                result.rows.sort_by(|a, b| b.first().cmp(&a.first()));
                result.rows.truncate(limit);
                Ok(result)
            }
        }
    }

    // ---- audit ----

    /// Records the decision, allowed or not. Auditing must never take the
    /// action down with it, so callers treat a returned error as log-and-go.
    pub fn audit(
        &self,
        user_email: &str,
        action: &str,
        target: Option<&str>,
        namespace: Option<&str>,
        detail: Option<&str>,
        allowed: bool,
    ) -> Result<(), String> {
        self.db.exec(&format!(
            "INSERT INTO audit_log (user_email, action, target, namespace, detail, allowed) \
             VALUES ({}, {}, {}, {}, {}, {});",
            sql_str(user_email)?,
            sql_str(action)?,
            sql_opt(target)?,
            sql_opt(namespace)?,
            sql_opt(detail)?,
            if allowed { "TRUE" } else { "FALSE" }
        ))
    }

    // ---- lookups ----

    pub fn user_id_by_email(&self, email: &str) -> Result<Option<String>, String> {
        Ok(self
            .db
            .query(&format!(
                "SELECT id FROM app_users WHERE email = {};",
                sql_str(email)?
            ))?
            .single()
            .map(str::to_string))
    }

    pub fn profile_id_by_name(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self
            .db
            .query(&format!("SELECT id FROM profiles WHERE name = {};", sql_str(name)?))?
            .single()
            .map(str::to_string))
    }

    fn profile_name(&self, profile_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .db
            .query(&format!(
                "SELECT name FROM profiles WHERE id = {};",
                sql_str(profile_id)?
            ))?
            .single()
            .map(str::to_string))
    }

    fn profile_ids_for(&self, user_id: &str) -> Result<Vec<String>, String> {
        Ok(self
            .db
            .query(&format!(
                "SELECT profile_id FROM user_profiles WHERE user_id = {};",
                sql_str(user_id)?
            ))?
            .rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }

    fn permissions_of(&self, profile_id: &str) -> Result<Vec<String>, String> {
        Ok(self
            .db
            .query(&format!(
                "SELECT permission FROM profile_permissions WHERE profile_id = {};",
                sql_str(profile_id)?
            ))?
            .rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("tmjlens-db-tests");
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(format!(
            "auth-{tag}-{}-{}.tmjp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn first_login_registers_with_zero_access() {
        let db = Db::open(&temp_db("register")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store
            .register_login("Novo.Colega@MDS.com", Some("Novo Colega"), None)
            .expect("login");
        // Email normalized, no profiles, no permissions: default deny.
        assert_eq!(user.email, "novo.colega@mds.com");
        assert!(user.profiles.is_empty());
        assert!(user.permissions.is_empty());
        assert!(!store.allows(&user, "view"));
        // The registration itself was audited.
        let log = db
            .query("SELECT action, allowed FROM audit_log;")
            .expect("audit");
        assert!(log.rows.iter().any(|r| {
            r[0].as_deref() == Some("first-login-registered") && r[1].as_deref() == Some("true")
        }));
    }

    #[test]
    fn seed_profiles_exist_and_only_once() {
        let path = temp_db("seeds");
        {
            let db = Db::open(&path).expect("open");
            AuthStore::new(&db).expect("first store");
        }
        let db = Db::open(&path).expect("reopen");
        AuthStore::new(&db).expect("second store");
        let profiles = db.query("SELECT name FROM profiles;").expect("profiles");
        let names: Vec<_> = profiles
            .rows
            .iter()
            .filter_map(|r| r[0].as_deref())
            .collect();
        assert_eq!(names.len(), 2, "seeds must not duplicate: {names:?}");
        assert!(names.contains(&"admin"));
        assert!(names.contains(&"viewer"));
    }

    #[test]
    fn granting_a_profile_grants_its_permissions() {
        let db = Db::open(&temp_db("grant")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store.register_login("dev@mds.com", None, None).expect("login");
        let viewer = store.profile_id_by_name("viewer").expect("q").expect("viewer");

        assert!(store.grant_profile(&user.id, &viewer, "tm.jacometti@gmail.com").unwrap());
        // Granting again reports nothing new instead of failing.
        assert!(!store.grant_profile(&user.id, &viewer, "tm.jacometti@gmail.com").unwrap());

        let user = store.load_user(&user.id).expect("reload");
        assert_eq!(user.profiles, ["viewer"]);
        assert!(store.allows(&user, "view"));
        assert!(store.allows(&user, "view-logs"));
        assert!(!store.allows(&user, "view-secrets"));
        assert!(!store.allows(&user, "delete-workloads"));

        store.revoke_profile(&user.id, &viewer).expect("revoke");
        let user = store.load_user(&user.id).expect("reload2");
        assert!(!store.allows(&user, "view"));
    }

    #[test]
    fn admin_holds_everything_implicitly() {
        let db = Db::open(&temp_db("admin")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store.register_login("chief@mds.com", None, None).expect("login");
        let admin = store.profile_id_by_name("admin").expect("q").expect("admin");
        store.grant_profile(&user.id, &admin, "seed").expect("grant");
        let user = store.load_user(&user.id).expect("reload");
        for (perm, _) in PERMISSIONS {
            assert!(store.allows(&user, perm), "admin lacked {perm}");
        }
    }

    #[test]
    fn deactivated_user_cannot_log_in_and_the_refusal_is_audited() {
        let db = Db::open(&temp_db("inactive")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store.register_login("left@mds.com", None, None).expect("login");
        store.set_user_active(&user.id, false).expect("deactivate");

        let err = store
            .register_login("left@mds.com", None, None)
            .expect_err("must refuse");
        assert!(err.contains("deactivated"), "unexpected: {err}");

        let log = db
            .query("SELECT action, allowed FROM audit_log;")
            .expect("audit");
        assert!(log.rows.iter().any(|r| {
            r[0].as_deref() == Some("login") && r[1].as_deref() == Some("false")
        }));
    }

    #[test]
    fn unknown_permission_strings_are_rejected_up_front() {
        let db = Db::open(&temp_db("unknown")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let viewer = store.profile_id_by_name("viewer").expect("q").expect("viewer");
        let err = store
            .add_permission(&viewer, "launch-missiles")
            .expect_err("must reject");
        assert!(err.contains("launch-missiles"));
    }

    #[test]
    fn bootstrap_admin_env_grants_admin_on_login() {
        // Env vars are process-wide; this is the only test that sets one.
        let db = Db::open(&temp_db("bootstrap")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        std::env::set_var("TMJLENS_BOOTSTRAP_ADMIN", "TM.Jacometti@Gmail.com");
        let user = store
            .register_login("tm.jacometti@gmail.com", Some("Thiago"), None)
            .expect("login");
        std::env::remove_var("TMJLENS_BOOTSTRAP_ADMIN");
        assert_eq!(user.profiles, ["admin"]);
        assert!(store.allows(&user, "admin"));
        let log = db.query("SELECT action FROM audit_log;").expect("audit");
        assert!(log
            .rows
            .iter()
            .any(|r| r[0].as_deref() == Some("bootstrap-admin-granted")));
    }
}
