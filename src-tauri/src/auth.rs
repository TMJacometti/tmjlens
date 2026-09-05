//! Who may do what. The ServiceAccount can do everything, so this module is
//! the actual security boundary of the web version: identity comes from SSO,
//! authorization lives here, and every decision — allowed or denied — lands in
//! the audit log, because the cluster's own audit trail will only ever name
//! the ServiceAccount.
//!
//! There are three fixed profiles. First SSO login grants `guest`. The one
//! exception is `TMJLENS_BOOTSTRAP_ADMIN`: the email it names is granted
//! `admin` instead, which is how the first admin exists at all.

use crate::db::{sql_opt, sql_str, Db};
use std::collections::HashSet;

/// Everything a profile may grant. The strings are what the database stores;
/// the descriptions exist for the admin screen. Deny is the absence of a row,
/// so an unknown string in the database grants nothing.
pub const PERMISSIONS: &[(&str, &str)] = &[
    ("overview", "See the Cluster Overview"),
    ("view", "See workloads, namespaces, storage, reports and plugin screens"),
    ("view-secrets", "Reveal Secret values and ConfigMap contents"),
    ("view-logs", "Read pod logs"),
    ("exec-pods", "Open a shell inside pods"),
    ("port-forward", "Forward cluster ports to the browser"),
    ("edit-yaml", "Edit any object as YAML"),
    ("edit-config", "Add, change and remove ConfigMap and Secret keys"),
    ("restart-workloads", "Rollout-restart controllers, replacing their pods"),
    ("scale-workloads", "Change replica counts"),
    ("delete-workloads", "Delete deployments, pods and other workloads"),
    ("manage-helm", "Uninstall and roll back Helm releases"),
    ("manage-velero", "Create backups and restores"),
    ("manage-argo", "Edit and submit Argo workflows, images, resources, schedules"),
    ("manage-nodes", "Cordon, drain and delete nodes"),
    ("manage-namespaces", "Create and delete namespaces, clear stuck finalizers"),
    ("admin", "Manage users, profiles and permissions"),
];

const ADMIN_DESC: &str = "Full control, including user management";
const DEVELOPER_DESC: &str =
    "Cluster Overview, workloads, logs and rollout restart. Cannot scale, delete a deploy, or port-forward.";
const GUEST_DESC: &str = "Cluster Overview only. Assigned automatically on first SSO login.";
const DEVELOPER_PERMS: &[&str] = &["overview", "view", "view-logs", "restart-workloads"];
const GUEST_PERMS: &[&str] = &["overview"];

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
    /// Wraps an open database and guarantees the three fixed profiles exist
    /// with their canonical permissions. Re-run on every boot so a trimmed
    /// row cannot quietly become a fourth, ad-hoc role.
    pub fn new(db: &'a Db) -> Result<AuthStore<'a>, String> {
        let store = AuthStore::attach(db);
        store.ensure_fixed_profiles()?;
        Ok(store)
    }

    /// A view over an already-seeded database — the per-request constructor.
    pub fn attach(db: &'a Db) -> AuthStore<'a> {
        AuthStore { db }
    }

    /// The login path. Registers an unknown email as `guest`, refreshes the
    /// known one, refuses a deactivated one, and applies the bootstrap admin
    /// grant when the environment names this email.
    pub fn register_login(
        &self,
        email: &str,
        display_name: Option<&str>,
        idp_subject: Option<&str>,
    ) -> Result<UserRecord, String> {
        let email = fold_email(email);
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
                let user_id = self.user_id_by_email(&email)?
                    .ok_or("user vanished right after registration")?;
                // Bootstrap admin is granted below; everyone else starts as guest
                // so the overview is visible the moment they sign in.
                if !is_bootstrap_admin(&email) {
                    if let Some(guest_id) = self.profile_id_by_name("guest")? {
                        self.grant_profile(&user_id, &guest_id, "first-login")?;
                    }
                    self.audit(&email, "first-login-registered", None, None,
                        Some("registered as guest"), true)?;
                } else {
                    self.audit(&email, "first-login-registered", None, None,
                        Some("registered; bootstrap admin grant follows"), true)?;
                }
                user_id
            }
        };

        if is_bootstrap_admin(&email) {
            if let Some(admin_id) = self.profile_id_by_name("admin")? {
                if self.grant_profile(&user_id, &admin_id, "bootstrap")? {
                    self.audit(&email, "bootstrap-admin-granted", None, None,
                        Some("email matches TMJLENS_BOOTSTRAP_ADMIN"), true)?;
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
    /// implicitly, so a profile does not need all rows to run the shop. `view`
    /// includes the overview — seeing the rest of the cluster includes seeing
    /// the front page.
    pub fn allows(&self, user: &UserRecord, permission: &str) -> bool {
        if !user.active {
            return false;
        }
        if user.permissions.iter().any(|p| p == "admin") {
            return true;
        }
        if user.permissions.iter().any(|p| p == permission) {
            return true;
        }
        permission == "overview" && user.permissions.iter().any(|p| p == "view")
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

    /// The three profiles the product actually has. Extra rows (a leftover
    /// `viewer`, a hand-made role) are left alone so existing grants still
    /// revoke cleanly, but they are not offered as something new to grant.
    fn ensure_fixed_profiles(&self) -> Result<(), String> {
        // v1 seeded `viewer`. Promote it so people already granted that row
        // keep access under the new name instead of silently becoming guests.
        if self.profile_id_by_name("developer")?.is_none() {
            if let Some(id) = self.profile_id_by_name("viewer")? {
                self.db.exec(&format!(
                    "UPDATE profiles SET name = {}, description = {} WHERE id = {};",
                    sql_str("developer")?,
                    sql_opt(Some(DEVELOPER_DESC))?,
                    sql_str(&id)?
                ))?;
            }
        }
        self.ensure_profile("admin", ADMIN_DESC, None)?;
        self.ensure_profile("developer", DEVELOPER_DESC, Some(DEVELOPER_PERMS))?;
        self.ensure_profile("guest", GUEST_DESC, Some(GUEST_PERMS))?;
        Ok(())
    }

    fn ensure_profile(
        &self,
        name: &str,
        description: &str,
        permissions: Option<&[&str]>,
    ) -> Result<(), String> {
        let id = match self.profile_id_by_name(name)? {
            Some(id) => {
                self.db.exec(&format!(
                    "UPDATE profiles SET description = {} WHERE id = {};",
                    sql_opt(Some(description))?,
                    sql_str(&id)?
                ))?;
                id
            }
            None => self.create_profile(name, Some(description))?,
        };
        let wanted: Vec<&str> = match permissions {
            None => PERMISSIONS.iter().map(|(perm, _)| *perm).collect(),
            Some(list) => list.to_vec(),
        };
        self.replace_permissions(&id, &wanted)
    }

    fn replace_permissions(&self, profile_id: &str, permissions: &[&str]) -> Result<(), String> {
        self.db.exec(&format!(
            "DELETE FROM profile_permissions WHERE profile_id = {};",
            sql_str(profile_id)?
        ))?;
        for perm in permissions {
            self.add_permission(profile_id, perm)?;
        }
        Ok(())
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

/// Corporate directories often emit the same mailbox in different casings.
/// Fold both sides the same way so `ADMIN@EMPRESA.COM` in Helm still matches
/// the SSO claim, whatever case Azure sent.
fn fold_email(value: &str) -> String {
    value.trim().to_lowercase()
}

fn is_bootstrap_admin(email: &str) -> bool {
    std::env::var("TMJLENS_BOOTSTRAP_ADMIN")
        .ok()
        .map(|value| fold_email(&value))
        .filter(|value| !value.is_empty())
        .map(|value| value == fold_email(email))
        .unwrap_or(false)
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
    fn first_login_registers_as_guest() {
        let db = Db::open(&temp_db("register")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store
            .register_login("Novo.Colega@TMJSistemas.com.br", Some("Novo Colega"), None)
            .expect("login");
        assert_eq!(user.email, "novo.colega@tmjsistemas.com.br");
        assert_eq!(user.profiles, ["guest"]);
        assert!(store.allows(&user, "overview"));
        assert!(!store.allows(&user, "view"));
        assert!(!store.allows(&user, "view-logs"));
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
        let mut names: Vec<_> = profiles
            .rows
            .iter()
            .filter_map(|r| r[0].as_deref())
            .collect();
        names.sort();
        assert_eq!(names, ["admin", "developer", "guest"], "seeds must not duplicate: {names:?}");
    }

    #[test]
    fn a_legacy_viewer_row_is_promoted_to_developer() {
        let path = temp_db("promote-viewer");
        {
            let db = Db::open(&path).expect("open");
            db.exec("INSERT INTO profiles (name, description) VALUES ('admin', NULL);")
                .expect("admin");
            db.exec("INSERT INTO profiles (name, description) VALUES ('viewer', NULL);")
                .expect("viewer");
            db.exec("INSERT INTO app_users (email) VALUES ('dev@tmjsistemas.com.br');")
                .expect("user");
            let user_id = db
                .query("SELECT id FROM app_users WHERE email = 'dev@tmjsistemas.com.br';")
                .expect("user id")
                .single()
                .expect("user row")
                .to_string();
            let viewer_id = db
                .query("SELECT id FROM profiles WHERE name = 'viewer';")
                .expect("viewer id")
                .single()
                .expect("viewer row")
                .to_string();
            db.exec(&format!(
                "INSERT INTO user_profiles (user_id, profile_id, granted_by_email) \
                 VALUES ({}, {}, 'seed');",
                sql_str(&user_id).unwrap(),
                sql_str(&viewer_id).unwrap()
            ))
            .expect("grant");
        }
        let db = Db::open(&path).expect("reopen");
        let store = AuthStore::new(&db).expect("store");
        assert!(store.profile_id_by_name("viewer").expect("q").is_none());
        let user_id = store.user_id_by_email("dev@tmjsistemas.com.br").expect("q").expect("user");
        let user = store.load_user(&user_id).expect("load");
        assert_eq!(user.profiles, ["developer"]);
        assert!(store.allows(&user, "overview"));
        assert!(store.allows(&user, "view-logs"));
        assert!(store.allows(&user, "restart-workloads"));
        assert!(!store.allows(&user, "scale-workloads"));
        assert!(!store.allows(&user, "delete-workloads"));
        assert!(!store.allows(&user, "port-forward"));
    }

    #[test]
    fn granting_developer_grants_restart_but_not_scale_or_delete() {
        let db = Db::open(&temp_db("grant")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store.register_login("dev@tmjsistemas.com.br", None, None).expect("login");
        let guest = store.profile_id_by_name("guest").expect("q").expect("guest");
        store.revoke_profile(&user.id, &guest).expect("revoke guest");
        let developer = store.profile_id_by_name("developer").expect("q").expect("developer");

        assert!(store.grant_profile(&user.id, &developer, "tm.jacometti@gmail.com").unwrap());
        assert!(!store.grant_profile(&user.id, &developer, "tm.jacometti@gmail.com").unwrap());

        let user = store.load_user(&user.id).expect("reload");
        assert_eq!(user.profiles, ["developer"]);
        assert!(store.allows(&user, "overview"));
        assert!(store.allows(&user, "view"));
        assert!(store.allows(&user, "view-logs"));
        assert!(store.allows(&user, "restart-workloads"));
        assert!(!store.allows(&user, "scale-workloads"));
        assert!(!store.allows(&user, "delete-workloads"));
        assert!(!store.allows(&user, "port-forward"));
        assert!(!store.allows(&user, "view-secrets"));

        store.revoke_profile(&user.id, &developer).expect("revoke");
        let user = store.load_user(&user.id).expect("reload2");
        assert!(!store.allows(&user, "view"));
        assert!(!store.allows(&user, "overview"));
    }

    #[test]
    fn admin_holds_everything_implicitly() {
        let db = Db::open(&temp_db("admin")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        let user = store.register_login("chief@tmjsistemas.com.br", None, None).expect("login");
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
        let user = store.register_login("left@tmjsistemas.com.br", None, None).expect("login");
        store.set_user_active(&user.id, false).expect("deactivate");

        let err = store
            .register_login("left@tmjsistemas.com.br", None, None)
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
        let guest = store.profile_id_by_name("guest").expect("q").expect("guest");
        let err = store
            .add_permission(&guest, "launch-missiles")
            .expect_err("must reject");
        assert!(err.contains("launch-missiles"));
    }

    #[test]
    fn bootstrap_admin_match_ignores_case_and_surrounding_space() {
        assert_eq!(
            fold_email("  ADMIN@EMPRESA.COM.BR "),
            "admin@empresa.com.br"
        );
        assert_eq!(
            fold_email("Admin@Empresa.com.br"),
            fold_email("ADMIN@EMPRESA.COM.BR")
        );
        assert_ne!(
            fold_email("admin@empresa.com.br"),
            fold_email("other@empresa.com.br")
        );
    }

    #[test]
    fn bootstrap_admin_env_grants_admin_on_login() {
        // Env vars are process-wide; this is the only test that sets one.
        let db = Db::open(&temp_db("bootstrap")).expect("open");
        let store = AuthStore::new(&db).expect("store");
        std::env::set_var("TMJLENS_BOOTSTRAP_ADMIN", "  TM.JACOMETTI@GMAIL.COM ");
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
