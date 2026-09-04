//! The web shell: axum in place of Tauri. The frontend keeps calling the same
//! command names — `POST /api/invoke/{command}` with the same JSON arguments
//! the desktop IPC carried — so every screen works unchanged over HTTP.
//!
//! This is where the security model decided for the web version is enforced:
//! the ServiceAccount can do anything, therefore EVERY request passes through
//! (1) a session that came from Azure AD OIDC, (2) the app-layer permission
//! gate, and (3) the audit log for anything beyond plain viewing. There is no
//! client-side enforcement anywhere — the browser only ever decides what to
//! draw, never what is allowed.

use crate::auth::{AuthStore, UserRecord, PERMISSIONS};
use crate::db::Db;
use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SESSION_COOKIE: &str = "tmjlens_session";
const SESSION_TTL: Duration = Duration::from_secs(8 * 60 * 60);
const LOGIN_TTL: Duration = Duration::from_secs(10 * 60);

struct Session {
    user_id: String,
    expires_at: Instant,
}

struct PendingLogin {
    nonce: String,
    created_at: Instant,
}

struct OidcConfig {
    tenant: String,
    client_id: String,
    client_secret: String,
    redirect_url: String,
}

pub struct WebState {
    db: Db,
    sessions: Mutex<HashMap<String, Session>>,
    pending: Mutex<HashMap<String, PendingLogin>>,
    oidc: Option<OidcConfig>,
    /// TMJLENS_DEV_USER: every request runs as this email, no IdP involved.
    /// A development convenience that must never reach a cluster manifest.
    dev_user: Option<String>,
    http: reqwest::Client,
    secure_cookie: bool,
}

pub async fn serve() -> Result<(), String> {
    let db_path = std::env::var("TMJLENS_DB_PATH").unwrap_or_else(|_| "data/tmjlens.tmjp".into());
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
    }
    let db = Db::open(std::path::Path::new(&db_path))?;
    eprintln!("tmjLite engine {} · database {db_path}", db.engine_version());
    // Seeds the admin/viewer profiles exactly once, at boot.
    AuthStore::new(&db)?;

    let dev_user = std::env::var("TMJLENS_DEV_USER").ok().filter(|v| !v.is_empty());
    let oidc = oidc_from_env()?;
    if oidc.is_none() && dev_user.is_none() {
        return Err(
            "no identity source configured: set TMJLENS_AZURE_TENANT_ID, \
             TMJLENS_AZURE_CLIENT_ID, TMJLENS_AZURE_CLIENT_SECRET and \
             TMJLENS_REDIRECT_URL for Azure AD login (or TMJLENS_DEV_USER \
             for local development only)"
                .into(),
        );
    }
    if dev_user.is_some() {
        eprintln!("WARNING: TMJLENS_DEV_USER is set — every request is trusted as that user. Development only.");
    }

    let state = std::sync::Arc::new(WebState {
        db,
        sessions: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        oidc,
        dev_user,
        http: reqwest::Client::new(),
        secure_cookie: std::env::var("TMJLENS_INSECURE_COOKIE").ok().as_deref() != Some("1"),
    });

    let static_dir = std::env::var("TMJLENS_STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let index = std::path::Path::new(&static_dir).join("index.html");
    let files = tower_http::services::ServeDir::new(&static_dir)
        .not_found_service(tower_http::services::ServeFile::new(index));

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/invoke/{command}", post(invoke))
        .fallback_service(files)
        .with_state(state);

    let addr = std::env::var("TMJLENS_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("could not bind {addr}: {e}"))?;
    eprintln!("tmjLens web listening on {addr}");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

fn oidc_from_env() -> Result<Option<OidcConfig>, String> {
    let vars = [
        "TMJLENS_AZURE_TENANT_ID",
        "TMJLENS_AZURE_CLIENT_ID",
        "TMJLENS_AZURE_CLIENT_SECRET",
        "TMJLENS_REDIRECT_URL",
    ];
    let values: Vec<Option<String>> = vars
        .iter()
        .map(|v| std::env::var(v).ok().filter(|s| !s.is_empty()))
        .collect();
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    if let Some(missing) = vars.iter().zip(&values).find(|(_, v)| v.is_none()) {
        return Err(format!("Azure AD login is partially configured: {} is missing", missing.0));
    }
    let mut it = values.into_iter().map(Option::unwrap);
    Ok(Some(OidcConfig {
        tenant: it.next().unwrap(),
        client_id: it.next().unwrap(),
        client_secret: it.next().unwrap(),
        redirect_url: it.next().unwrap(),
    }))
}

// ---- identity -------------------------------------------------------------

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix(&format!("{SESSION_COOKIE}=")).map(str::to_string))
}

/// Resolve the caller. Permissions are re-read from the database on every
/// request, so a revoke applies immediately, not at next login.
fn current_user(state: &WebState, headers: &HeaderMap) -> Result<UserRecord, Response> {
    let store = AuthStore::attach(&state.db);
    if let Some(token) = cookie_token(headers) {
        let user_id = {
            let mut sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
            match sessions.get_mut(&token) {
                Some(session) if session.expires_at > Instant::now() => {
                    session.expires_at = Instant::now() + SESSION_TTL;
                    Some(session.user_id.clone())
                }
                Some(_) => {
                    sessions.remove(&token);
                    None
                }
                None => None,
            }
        };
        if let Some(user_id) = user_id {
            return store.load_user(&user_id).map_err(|e| plain(StatusCode::UNAUTHORIZED, &e));
        }
    }
    if let Some(email) = &state.dev_user {
        return store
            .register_login(email, Some("Dev user"), None)
            .map_err(|e| plain(StatusCode::UNAUTHORIZED, &e));
    }
    Err(plain(StatusCode::UNAUTHORIZED, "not signed in"))
}

fn plain(status: StatusCode, body: &str) -> Response {
    (status, body.to_string()).into_response()
}

// ---- OIDC (Azure AD / Entra ID) -------------------------------------------

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

async fn login(State(state): State<std::sync::Arc<WebState>>) -> Response {
    let Some(oidc) = &state.oidc else {
        return plain(
            StatusCode::NOT_IMPLEMENTED,
            "Azure AD login is not configured on this deployment",
        );
    };
    let csrf = random_token();
    let nonce = random_token();
    {
        let mut pending = state.pending.lock().unwrap_or_else(|p| p.into_inner());
        pending.retain(|_, p| p.created_at.elapsed() < LOGIN_TTL);
        pending.insert(csrf.clone(), PendingLogin { nonce: nonce.clone(), created_at: Instant::now() });
    }
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/authorize\
         ?client_id={}&response_type=code&redirect_uri={}&response_mode=query\
         &scope=openid%20profile%20email&state={}&nonce={}",
        urlencode(&oidc.tenant),
        urlencode(&oidc.client_id),
        urlencode(&oidc.redirect_url),
        csrf,
        nonce,
    );
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, url)
        .body(Body::empty())
        .unwrap()
}

#[derive(serde::Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    id_token: String,
}

#[derive(serde::Deserialize)]
struct IdClaims {
    iss: String,
    aud: String,
    exp: i64,
    nonce: Option<String>,
    email: Option<String>,
    preferred_username: Option<String>,
    name: Option<String>,
    sub: String,
}

async fn callback(
    State(state): State<std::sync::Arc<WebState>>,
    Query(params): Query<CallbackParams>,
) -> Response {
    let Some(oidc) = &state.oidc else {
        return plain(StatusCode::NOT_IMPLEMENTED, "Azure AD login is not configured");
    };
    if let Some(error) = params.error {
        let detail = params.error_description.unwrap_or_default();
        return plain(StatusCode::UNAUTHORIZED, &format!("Azure AD refused the login: {error} {detail}"));
    }
    let (Some(code), Some(csrf)) = (params.code, params.state) else {
        return plain(StatusCode::BAD_REQUEST, "the login response is missing code or state");
    };
    let Some(pending) = state.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&csrf) else {
        return plain(StatusCode::UNAUTHORIZED, "unknown or expired login attempt — start again at /auth/login");
    };
    if pending.created_at.elapsed() > LOGIN_TTL {
        return plain(StatusCode::UNAUTHORIZED, "the login attempt expired — start again at /auth/login");
    }

    let token_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        urlencode(&oidc.tenant)
    );
    let form = [
        ("client_id", oidc.client_id.as_str()),
        ("client_secret", oidc.client_secret.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", oidc.redirect_url.as_str()),
    ];
    let response = match state.http.post(&token_url).form(&form).send().await {
        Ok(r) => r,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("could not reach Azure AD: {e}")),
    };
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return plain(StatusCode::UNAUTHORIZED, &format!("Azure AD rejected the code exchange: {body}"));
    }
    let tokens: TokenResponse = match response.json().await {
        Ok(t) => t,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("unreadable token response: {e}")),
    };

    // The id_token arrived over the direct TLS channel to the issuer's token
    // endpoint, which is the OIDC-sanctioned alternative to verifying its
    // signature (Core §3.1.3.7). The claims are still validated one by one.
    let claims = match decode_id_token(&tokens.id_token) {
        Ok(c) => c,
        Err(e) => return plain(StatusCode::UNAUTHORIZED, &e),
    };
    let expected_iss_prefix = "https://login.microsoftonline.com/";
    if !claims.iss.starts_with(expected_iss_prefix) {
        return plain(StatusCode::UNAUTHORIZED, "the token issuer is not Microsoft");
    }
    if claims.aud != oidc.client_id {
        return plain(StatusCode::UNAUTHORIZED, "the token was issued for a different application");
    }
    if claims.exp < chrono::Utc::now().timestamp() {
        return plain(StatusCode::UNAUTHORIZED, "the token is already expired");
    }
    if claims.nonce.as_deref() != Some(pending.nonce.as_str()) {
        return plain(StatusCode::UNAUTHORIZED, "the token does not answer this login attempt");
    }
    let Some(email) = claims.email.or(claims.preferred_username) else {
        return plain(
            StatusCode::UNAUTHORIZED,
            "Azure AD sent no email for this account; the app cannot register it",
        );
    };

    let store = AuthStore::attach(&state.db);
    let user = match store.register_login(&email, claims.name.as_deref(), Some(&claims.sub)) {
        Ok(u) => u,
        Err(e) => return plain(StatusCode::FORBIDDEN, &e),
    };

    let token = random_token();
    {
        let mut sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions.retain(|_, s| s.expires_at > Instant::now());
        sessions.insert(token.clone(), Session { user_id: user.id, expires_at: Instant::now() + SESSION_TTL });
    }
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    Response::builder()
        .status(StatusCode::FOUND)
        .header(
            header::SET_COOKIE,
            format!("{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/{secure}"),
        )
        .header(header::LOCATION, "/")
        .body(Body::empty())
        .unwrap()
}

fn decode_id_token(token: &str) -> Result<IdClaims, String> {
    use base64::Engine;
    let payload = token
        .split('.')
        .nth(1)
        .ok_or("the id_token is not a JWT")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| format!("the id_token payload is not base64: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("the id_token claims are unreadable: {e}"))
}

async fn logout(State(state): State<std::sync::Arc<WebState>>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers) {
        state.sessions.lock().unwrap_or_else(|p| p.into_inner()).remove(&token);
    }
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::SET_COOKIE,
            format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}"),
        )
        .body(Body::from("signed out"))
        .unwrap()
}

async fn me(State(state): State<std::sync::Arc<WebState>>, headers: HeaderMap) -> Response {
    match current_user(&state, &headers) {
        Ok(user) => (StatusCode::OK, axum::Json(user)).into_response(),
        Err(response) => response,
    }
}

// ---- the command gate ------------------------------------------------------

/// What each command requires. The empty string means signed-in is enough:
/// those are the shell's own bookkeeping calls, which even a zero-access user
/// needs so the app can render a "no access" state instead of a broken one.
fn required_permission(cmd: &str) -> &'static str {
    if cmd.starts_with("admin_") {
        return "admin";
    }
    match cmd {
        "load_settings" | "save_settings" | "current_context" | "list_kube_contexts"
        | "read_kubeconfig" | "check_permission" => "",
        "get_pod_logs" => "view-logs",
        "reveal_secret_key" | "read_config_map_key" => "view-secrets",
        "apply_resource_yaml" => "edit-yaml",
        "write_secret_key" | "write_config_map_key" | "delete_configuration_key" => "edit-config",
        "scale_workload" | "restart_workload" => "scale-workloads",
        "delete_pod" | "delete_workload" | "delete_deployment" => "delete-workloads",
        "set_argo_image" | "set_argo_resources" | "set_argo_schedule" | "set_argo_cron_suspend"
        | "submit_argo_template" | "stop_argo_workflow" | "delete_argo_workflow" => "manage-argo",
        "uninstall_helm_release" | "rollback_helm_release" => "manage-helm",
        "create_velero_backup" | "create_velero_restore" => "manage-velero",
        "set_node_schedulable" | "delete_node" | "drain_node" => "manage-nodes",
        _ => "view",
    }
}

/// Commands the app answers itself instead of asking the cluster: settings and
/// context bookkeeping that only make sense on a desktop, plus the permission
/// probe, which on the web must reflect the app layer, never the SA's RBAC.
fn shell_command(cmd: &str, args: &Value, user: &UserRecord, store: &AuthStore) -> Option<Result<Value, String>> {
    let result = match cmd {
        "load_settings" => {
            let mut settings = crate::settings::AppSettings::default();
            settings
                .context_environments
                .insert("in-cluster".to_string(), "production".to_string());
            serde_json::to_value(settings).map_err(|e| e.to_string())
        }
        "save_settings" => Ok(Value::Null),
        "current_context" => Ok(json!({ "name": "in-cluster", "namespace": Value::Null })),
        "list_kube_contexts" => Ok(json!([{ "name": "in-cluster", "current": true, "namespace": Value::Null }])),
        "read_kubeconfig" => Ok(json!({
            "path": Value::Null,
            "writable": false,
            "read_only_reason": "The web version runs as the cluster's ServiceAccount; there is no kubeconfig to edit.",
            "current_context": "in-cluster",
            "contexts": [{
                "name": "in-cluster", "current": true, "cluster": "in-cluster",
                "user": "service-account", "namespace": Value::Null, "server": Value::Null,
                "auth_method": "service account", "environment": "production"
            }]
        })),
        "check_permission" => {
            let verb: String = arg(args, "verb").unwrap_or_default();
            let resource: String = arg(args, "resource").unwrap_or_default();
            let subresource: Option<String> = arg(args, "subresource").unwrap_or(None);
            let group: Option<String> = arg(args, "group").unwrap_or(None);
            let needed = permission_for_review(&verb, &resource, subresource.as_deref(), group.as_deref());
            Ok(Value::Bool(store.allows(user, needed)))
        }

        // -- administration: gated by 'admin' in required_permission --
        "admin_list_users" => store.list_users().and_then(val),
        "admin_list_profiles" => store.list_profiles().and_then(val),
        "admin_list_permissions" => Ok(json!(PERMISSIONS
            .iter()
            .map(|(name, description)| json!({ "name": name, "description": description }))
            .collect::<Vec<_>>())),
        "admin_create_profile" => (|| {
            let name: String = arg(args, "name")?;
            let description: Option<String> = arg(args, "description")?;
            store.create_profile(&name, description.as_deref()).map(Value::String)
        })(),
        "admin_add_permission" => (|| {
            let profile_id: String = arg(args, "profile_id")?;
            let permission: String = arg(args, "permission")?;
            store.add_permission(&profile_id, &permission).map(|()| Value::Null)
        })(),
        "admin_remove_permission" => (|| {
            let profile_id: String = arg(args, "profile_id")?;
            let permission: String = arg(args, "permission")?;
            store.remove_permission(&profile_id, &permission).map(|()| Value::Null)
        })(),
        "admin_grant_profile" => (|| {
            let user_id: String = arg(args, "user_id")?;
            let profile_id: String = arg(args, "profile_id")?;
            store.grant_profile(&user_id, &profile_id, &user.email).map(Value::Bool)
        })(),
        "admin_revoke_profile" => (|| {
            let user_id: String = arg(args, "user_id")?;
            let profile_id: String = arg(args, "profile_id")?;
            store.revoke_profile(&user_id, &profile_id).map(|()| Value::Null)
        })(),
        "admin_set_user_active" => (|| {
            let user_id: String = arg(args, "user_id")?;
            let active: bool = arg(args, "active")?;
            // Locking every admin out with one click is the classic self-inflicted
            // outage; deactivating yourself is refused, someone else must do it.
            if user_id == user.id && !active {
                return Err("you cannot deactivate your own account".to_string());
            }
            store.set_user_active(&user_id, active).map(|()| Value::Null)
        })(),
        "admin_audit_log" => (|| {
            let limit: Option<usize> = arg(args, "limit")?;
            store.recent_audit(limit.unwrap_or(200).min(2000)).and_then(val)
        })(),
        _ => return None,
    };
    Some(result)
}

/// Maps the Kubernetes access the frontend asks about to the app permission
/// that actually governs it here.
fn permission_for_review(
    verb: &str,
    resource: &str,
    subresource: Option<&str>,
    group: Option<&str>,
) -> &'static str {
    let group = group.unwrap_or("");
    if group.contains("velero") {
        return "manage-velero";
    }
    if group.contains("argoproj") {
        return "manage-argo";
    }
    match subresource {
        Some("exec") => return "exec-pods",
        Some("log") => return "view-logs",
        Some("scale") => return "scale-workloads",
        Some("portforward") => return "port-forward",
        _ => {}
    }
    let reading = matches!(verb, "get" | "list" | "watch");
    if resource == "nodes" && !reading {
        return "manage-nodes";
    }
    match verb {
        "get" | "list" | "watch" => {
            if resource == "secrets" { "view-secrets" } else { "view" }
        }
        "delete" | "deletecollection" => "delete-workloads",
        "create" | "update" | "patch" => match resource {
            "configmaps" | "secrets" => "edit-config",
            _ => "edit-yaml",
        },
        _ => "admin",
    }
}

async fn invoke(
    State(state): State<std::sync::Arc<WebState>>,
    UrlPath(command): UrlPath<String>,
    headers: HeaderMap,
    body: axum::Json<Value>,
) -> Response {
    let user = match current_user(&state, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let args = body.0;
    let store = AuthStore::attach(&state.db);

    // The gate comes before ANY execution path — the admin commands answered
    // by shell_command must clear it exactly like a cluster command does.
    let needed = required_permission(&command);
    if !needed.is_empty() && !store.allows(&user, needed) {
        let _ = store.audit(
            &user.email,
            &command,
            audit_target(&args).as_deref(),
            audit_namespace(&args).as_deref(),
            Some(&format!("denied: requires '{needed}'")),
            false,
        );
        return plain(
            StatusCode::FORBIDDEN,
            &format!("You do not have '{needed}' permission. An admin can grant it."),
        );
    }

    let outcome = match shell_command(&command, &args, &user, &store) {
        Some(result) => result,
        None => dispatch(&command, &args).await,
    };

    // Reads gated only by 'view' or 'view-logs' would flood the log from
    // polling; everything else — including revealing a secret — is recorded.
    if !matches!(needed, "" | "view" | "view-logs") {
        let detail = outcome.as_ref().err().map(|e| format!("failed: {e}"));
        let _ = store.audit(
            &user.email,
            &command,
            audit_target(&args).as_deref(),
            audit_namespace(&args).as_deref(),
            detail.as_deref(),
            true,
        );
    }

    match outcome {
        Ok(value) => (StatusCode::OK, axum::Json(value)).into_response(),
        Err(error) => plain(StatusCode::BAD_REQUEST, &error),
    }
}

fn audit_target(args: &Value) -> Option<String> {
    for key in ["name", "pod_name", "podName", "deployment_name", "deploymentName", "node_name", "nodeName", "resource_name", "resourceName"] {
        if let Some(v) = args.get(key).and_then(Value::as_str) {
            return Some(v.to_string());
        }
    }
    None
}

fn audit_namespace(args: &Value) -> Option<String> {
    for key in ["namespace", "velero_namespace", "veleroNamespace"] {
        if let Some(v) = args.get(key).and_then(Value::as_str) {
            return Some(v.to_string());
        }
    }
    None
}

// ---- dispatch --------------------------------------------------------------

fn snake_to_camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper_next = false;
    for c in name.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Reads one named argument, accepting both the Rust spelling and the
/// camelCase the desktop frontend has always sent over Tauri IPC.
fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args
        .get(name)
        .or_else(|| args.get(snake_to_camel(name)))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| format!("argument '{name}' is invalid: {e}"))
}

fn val<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn dispatch(cmd: &str, a: &Value) -> Result<Value, String> {
    use super::*;
    match cmd {
        "list_namespaces" => val(list_namespaces(arg(a, "context")?).await?),
        "list_pods" => val(list_pods(arg(a, "context")?, arg(a, "namespace")?).await?),
        "list_pod_containers" => val(list_pod_containers(arg(a, "context")?, arg(a, "namespace")?, arg(a, "pod_name")?).await?),
        "get_pod_logs" => val(get_pod_logs(arg(a, "context")?, arg(a, "namespace")?, arg(a, "pod_name")?, arg(a, "container")?, arg(a, "tail_lines")?, arg(a, "previous")?).await?),
        "get_deployment_detail" => val(get_deployment_detail(arg(a, "context")?, arg(a, "namespace")?, arg(a, "deployment_name")?).await?),
        "export_deployment_yaml" => val(export_deployment_yaml(arg(a, "context")?, arg(a, "namespace")?, arg(a, "deployment_name")?).await?),
        "delete_workload" => val(delete_workload(arg(a, "context")?, arg(a, "namespace")?, arg(a, "kind")?, arg(a, "name")?).await?),
        "get_relation_graph" => val(get_relation_graph(arg(a, "context")?, arg(a, "namespace")?, arg(a, "deployment_name")?).await?),
        "get_configuration" => val(get_configuration(arg(a, "context")?, arg(a, "namespace")?).await?),
        "reveal_secret_key" => val(reveal_secret_key(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "key")?).await?),
        "read_config_map_key" => val(read_config_map_key(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "key")?).await?),
        "write_secret_key" => val(write_secret_key(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "key")?, arg(a, "value")?).await?),
        "write_config_map_key" => val(write_config_map_key(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "key")?, arg(a, "value")?).await?),
        "delete_configuration_key" => val(delete_configuration_key(arg(a, "context")?, arg(a, "namespace")?, arg(a, "kind")?, arg(a, "name")?, arg(a, "key")?).await?),
        "get_deploy_report" => val(get_deploy_report(arg(a, "context")?, arg(a, "namespaces")?, arg(a, "window")?).await?),
        "list_report_kinds" => val(list_report_kinds()),
        "run_report" => val(run_report(arg(a, "context")?, arg(a, "report")?, arg(a, "namespaces")?, arg(a, "window")?, arg(a, "compare_context")?).await?),
        "get_namespace_overview" => val(get_namespace_overview(arg(a, "context")?).await?),
        "get_storage_overview" => val(get_storage_overview(arg(a, "context")?, arg(a, "namespace")?).await?),
        "get_argo_overview" => val(get_argo_overview(arg(a, "context")?).await?),
        "set_argo_image" => val(set_argo_image(arg(a, "context")?, arg(a, "kind")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "template")?, arg(a, "container")?, arg(a, "expected")?, arg(a, "image")?).await?),
        "set_argo_resources" => val(set_argo_resources(arg(a, "context")?, arg(a, "kind")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "template")?, arg(a, "container")?, arg(a, "expected")?, arg(a, "resources")?).await?),
        "set_argo_schedule" => val(set_argo_schedule(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "expected")?, arg(a, "schedule")?).await?),
        "set_argo_cron_suspend" => val(set_argo_cron_suspend(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "suspend")?).await?),
        "submit_argo_template" => val(submit_argo_template(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?).await?),
        "stop_argo_workflow" => val(stop_argo_workflow(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?).await?),
        "delete_argo_workflow" => val(delete_argo_workflow(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?).await?),
        "get_pod_metrics" => val(get_pod_metrics(arg(a, "context")?, arg(a, "namespace")?).await?),
        "get_helm_overview" => val(get_helm_overview(arg(a, "context")?).await?),
        "get_helm_release" => val(get_helm_release(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?).await?),
        "uninstall_helm_release" => val(uninstall_helm_release(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?).await?),
        "rollback_helm_release" => val(rollback_helm_release(arg(a, "context")?, arg(a, "namespace")?, arg(a, "name")?, arg(a, "revision")?).await?),
        "get_velero_status" => val(get_velero_status(arg(a, "context")?, arg(a, "velero_namespace")?).await?),
        "create_velero_backup" => val(create_velero_backup(arg(a, "context")?, arg(a, "velero_namespace")?, arg(a, "name")?, arg(a, "included_namespaces")?, arg(a, "ttl_hours")?, arg(a, "storage_location")?, arg(a, "include_volumes")?).await?),
        "create_velero_restore" => val(create_velero_restore(arg(a, "context")?, arg(a, "velero_namespace")?, arg(a, "name")?, arg(a, "backup_name")?, arg(a, "included_namespaces")?).await?),
        "search_cluster" => val(search_cluster(arg(a, "context")?, arg(a, "query")?).await?),
        "list_workloads" => val(list_workloads(arg(a, "context")?, arg(a, "namespace")?).await?),
        "get_network_overview" => val(get_network_overview(arg(a, "context")?, arg(a, "namespace")?).await?),
        "delete_pod" => val(delete_pod(arg(a, "context")?, arg(a, "namespace")?, arg(a, "pod_name")?).await?),
        "get_resource_yaml" => val(get_resource_yaml(arg(a, "context")?, arg(a, "namespace")?, arg(a, "resource_kind")?, arg(a, "resource_name")?).await?),
        "apply_resource_yaml" => val(apply_resource_yaml(arg(a, "context")?, arg(a, "namespace")?, arg(a, "resource_kind")?, arg(a, "resource_name")?, arg(a, "yaml")?).await?),
        "list_deployments" => val(list_deployments(arg(a, "context")?, arg(a, "namespace")?).await?),
        "list_namespace_snapshot" => val(list_namespace_snapshot(arg(a, "context")?, arg(a, "namespace")?).await?),
        "get_cluster_overview" => val(get_cluster_overview(arg(a, "context")?).await?),
        "set_node_schedulable" => val(set_node_schedulable(arg(a, "context")?, arg(a, "node_name")?, arg(a, "schedulable")?).await?),
        "delete_node" => val(delete_node(arg(a, "context")?, arg(a, "node_name")?).await?),
        "drain_node" => val(drain_node(arg(a, "context")?, arg(a, "node_name")?).await?),
        "delete_deployment" => val(delete_deployment(arg(a, "context")?, arg(a, "namespace")?, arg(a, "deployment_name")?).await?),
        "scale_workload" => val(scale_workload(arg(a, "context")?, arg(a, "namespace")?, arg(a, "kind")?, arg(a, "name")?, arg(a, "replicas")?).await?),
        "restart_workload" => val(restart_workload(arg(a, "context")?, arg(a, "namespace")?, arg(a, "kind")?, arg(a, "name")?).await?),
        "list_events" => val(list_events(arg(a, "context")?, arg(a, "namespace")?).await?),
        other => Err(format!("'{other}' is not a command this server knows")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_names_gain_their_camel_spelling() {
        assert_eq!(snake_to_camel("pod_name"), "podName");
        assert_eq!(snake_to_camel("context"), "context");
        assert_eq!(snake_to_camel("included_namespaces"), "includedNamespaces");
    }

    #[test]
    fn args_accept_both_spellings_and_report_what_is_missing() {
        let a = json!({ "podName": "api-1", "namespace": "payments" });
        assert_eq!(arg::<String>(&a, "pod_name").unwrap(), "api-1");
        assert_eq!(arg::<String>(&a, "namespace").unwrap(), "payments");
        assert_eq!(arg::<Option<String>>(&a, "container").unwrap(), None);
        let err = arg::<String>(&a, "kind").expect_err("required arg");
        assert!(err.contains("kind"));
    }

    #[test]
    fn mutating_commands_demand_more_than_view() {
        for cmd in [
            "delete_pod", "delete_workload", "delete_deployment", "apply_resource_yaml",
            "write_secret_key", "write_config_map_key", "delete_configuration_key",
            "scale_workload", "restart_workload", "uninstall_helm_release",
            "rollback_helm_release", "create_velero_backup", "create_velero_restore",
            "set_argo_image", "set_argo_resources", "set_argo_schedule",
            "set_argo_cron_suspend", "submit_argo_template", "stop_argo_workflow",
            "delete_argo_workflow", "set_node_schedulable", "delete_node", "drain_node",
            "reveal_secret_key",
        ] {
            assert_ne!(required_permission(cmd), "view", "{cmd} must not pass as a read");
        }
        assert_eq!(required_permission("list_pods"), "view");
        assert_eq!(required_permission("get_cluster_overview"), "view");
    }

    #[test]
    fn admin_commands_demand_admin_and_shell_calls_only_a_login() {
        for cmd in [
            "admin_list_users", "admin_grant_profile", "admin_revoke_profile",
            "admin_set_user_active", "admin_audit_log", "admin_create_profile",
        ] {
            assert_eq!(required_permission(cmd), "admin", "{cmd}");
        }
        for cmd in ["load_settings", "current_context", "check_permission", "read_kubeconfig"] {
            assert_eq!(required_permission(cmd), "", "{cmd}");
        }
    }

    #[test]
    fn access_review_questions_map_to_app_permissions() {
        assert_eq!(permission_for_review("get", "secrets", None, None), "view-secrets");
        assert_eq!(permission_for_review("list", "pods", None, None), "view");
        assert_eq!(permission_for_review("delete", "deployments", None, None), "delete-workloads");
        assert_eq!(permission_for_review("patch", "configmaps", None, None), "edit-config");
        assert_eq!(permission_for_review("patch", "deployments", None, None), "edit-yaml");
        assert_eq!(permission_for_review("create", "pods", Some("exec"), None), "exec-pods");
        assert_eq!(permission_for_review("get", "pods", Some("log"), None), "view-logs");
        assert_eq!(permission_for_review("patch", "deployments", Some("scale"), None), "scale-workloads");
        assert_eq!(permission_for_review("delete", "nodes", None, None), "manage-nodes");
        assert_eq!(permission_for_review("patch", "nodes", None, None), "manage-nodes");
        assert_eq!(permission_for_review("create", "backups", None, Some("velero.io")), "manage-velero");
        assert_eq!(permission_for_review("update", "workflows", None, Some("argoproj.io")), "manage-argo");
    }

    #[test]
    fn unknown_commands_are_refused_not_guessed() {
        let outcome = futures::executor::block_on(dispatch("open_reverse_shell", &json!({})));
        assert!(outcome.is_err());
    }

    #[test]
    fn urlencoding_covers_the_delimiters_oidc_needs() {
        assert_eq!(urlencode("https://app/auth/callback"), "https%3A%2F%2Fapp%2Fauth%2Fcallback");
        assert_eq!(urlencode("abc-123_ok.~"), "abc-123_ok.~");
    }
}
