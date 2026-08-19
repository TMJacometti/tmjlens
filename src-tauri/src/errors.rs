/// Turns the failures operators actually hit into sentences that name the cause and
/// the fix, without discarding the original text.
///
/// The commonest one by far is an expired cloud session: kubeconfig delegates
/// authentication to `aws`, `az` or `gcloud` through an exec credential plugin, and
/// when that session lapses the raw error is a wall of process plumbing wrapped around
/// one useful line. tmjLens runs that command and forwards what it returns — it holds
/// no cloud credential of its own, and stores nothing — so the fix is always in the
/// external tool, never in this app.
pub fn humanize(raw: &str) -> String {
    if let Some(explanation) = expired_session(raw) {
        return explanation;
    }

    if raw.contains("connection refused") || raw.contains("dns error") || raw.contains("failed to lookup address") {
        return format!(
            "The cluster API server could not be reached. It may be private, behind a VPN, or the context may point \
             at an endpoint that no longer exists.\n\n{raw}"
        );
    }

    if raw.contains("certificate") && (raw.contains("expired") || raw.contains("not valid")) {
        return format!("The cluster's TLS certificate was rejected.\n\n{raw}");
    }

    raw.to_string()
}

/// Recognises an exec credential plugin that ran and refused.
///
/// Matched on the exec-plugin framing rather than on any one CLI's wording, so a new
/// provider's phrasing still lands here instead of falling through as raw text.
fn expired_session(raw: &str) -> Option<String> {
    let is_exec_failure = raw.contains("auth exec command") || raw.contains("exec plugin");
    let says_expired = raw.contains("session has expired")
        || raw.contains("Token has expired")
        || raw.contains("refresh token")
        || raw.contains("reauthenticate")
        || raw.contains("az login")
        || raw.contains("gcloud auth login");

    if !is_exec_failure && !says_expired {
        return None;
    }

    let tool = if raw.contains("\"aws\"") || raw.contains("aws login") || raw.contains("aws sso") {
        Some(("AWS", "aws sso login"))
    } else if raw.contains("\"az\"") || raw.contains("az login") {
        Some(("Azure", "az login"))
    } else if raw.contains("\"gke-gcloud-auth-plugin\"") || raw.contains("gcloud") {
        Some(("Google Cloud", "gcloud auth login"))
    } else {
        None
    };

    let lead = match tool {
        Some((cloud, command)) => format!(
            "Your {cloud} session has expired. Sign in again in a terminal with `{command}`, then select Try again.",
        ),
        None => "The credential command in your kubeconfig failed, which usually means the cloud session expired. \
                 Sign in again with your provider's CLI, then select Try again."
            .to_string(),
    };

    Some(format!(
        "{lead}\n\ntmjLens does not hold cloud credentials. It runs the command your kubeconfig names and passes the \
         token straight to the cluster, keeping nothing on disk — so the sign-in has to happen in that tool.\n\n{raw}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWS_EXPIRED: &str = "auth error: auth exec command '\"aws\" \"--region\" \"us-west-2\" \"eks\" \
        \"get-token\" \"--cluster-name\" \"eks-cluster-prd\" \"--output\" \"json\"' failed with status exit code: \
        255: Output { status: ExitStatus(ExitStatus(255)), stdout: \"\", stderr: \"\\r\\nYour session has expired. \
        Please reauthenticate using 'aws login'.\\r\\n\" }";

    #[test]
    fn an_expired_aws_session_names_the_cloud_and_the_command() {
        let message = humanize(AWS_EXPIRED);
        assert!(message.starts_with("Your AWS session has expired."));
        assert!(message.contains("aws sso login"));
    }

    #[test]
    fn the_original_error_is_kept_rather_than_replaced() {
        // An operator debugging a genuinely odd failure still needs the raw text.
        assert!(humanize(AWS_EXPIRED).contains("exit code: 255"));
    }

    #[test]
    fn it_states_that_no_credential_is_stored() {
        let message = humanize(AWS_EXPIRED);
        assert!(message.contains("does not hold cloud credentials"));
        assert!(message.contains("keeping nothing on disk"));
    }

    #[test]
    fn azure_and_google_are_recognised_by_their_own_tooling() {
        let azure = humanize("auth exec command '\"az\" \"account\" \"get-access-token\"' failed: run az login");
        assert!(azure.starts_with("Your Azure session has expired."));
        assert!(azure.contains("az login"));

        let google = humanize(
            "auth exec command '\"gke-gcloud-auth-plugin\"' failed: reauthenticate with gcloud auth login",
        );
        assert!(google.starts_with("Your Google Cloud session has expired."));
    }

    #[test]
    fn an_unrecognised_exec_failure_still_points_at_the_cli_rather_than_the_app() {
        let message = humanize("auth exec command '\"custom-token-helper\"' failed with status exit code: 1");
        assert!(message.contains("credential command in your kubeconfig failed"));
        assert!(message.contains("custom-token-helper"));
    }

    #[test]
    fn an_unreachable_endpoint_is_distinguished_from_a_credential_problem() {
        let message = humanize("error trying to connect: tcp connect error: connection refused (os error 61)");
        assert!(message.contains("could not be reached"));
        assert!(message.contains("VPN"));
    }

    #[test]
    fn an_ordinary_error_is_passed_through_untouched() {
        // Rewriting errors it does not understand would only obscure them.
        let raw = "deployments.apps \"checkout-api\" not found";
        assert_eq!(humanize(raw), raw);
    }

    #[test]
    fn a_forbidden_response_is_not_mistaken_for_an_expired_session() {
        let raw = "pods is forbidden: User \"reader\" cannot list resource \"pods\"";
        assert_eq!(humanize(raw), raw);
    }
}
