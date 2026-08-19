#!/usr/bin/env bash
#
# Locks `main` so every change lands through a pull request.
#
# Run once, after `gh auth login`:
#     bash .github/setup-branch-protection.sh
#
# Notes on the choices below:
#
#   required_approving_review_count = 0
#       A solo maintainer cannot approve their own pull request. Zero still forces
#       the PR flow — nothing lands by pushing straight to main — without locking
#       the maintainer out. Raise it to 1 the moment a second maintainer exists.
#
#   enforce_admins = false
#       Admins can still push in an emergency. Everyone else physically cannot:
#       on a public repository, people without write access can only fork and open
#       a pull request. Set to true once the project has more than one maintainer.
#
#   allow_force_pushes / allow_deletions = false
#       History on main is not rewritable and the branch cannot be deleted.

set -euo pipefail

REPO="${1:-TMJacometti/tmjlens}"
BRANCH="${2:-main}"

command -v gh >/dev/null || { echo "gh is not installed: winget install --id GitHub.cli"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not authenticated: run 'gh auth login'"; exit 1; }

echo "Protecting ${REPO}@${BRANCH}…"

gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo
echo "Done. Verify:"
echo "  gh api repos/${REPO}/branches/${BRANCH}/protection --jq '{pr: .required_pull_request_reviews, force: .allow_force_pushes.enabled, delete: .allow_deletions.enabled}'"
