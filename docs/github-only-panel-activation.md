# NestNyx GitHub-only MCP Panel v2 — cloud activation

This change affects the **NestNyx Node backend**, not the canonical Yaro Head,
Body or Footer. `nyx_connections_panel` is a separate MCP connection-management
tool, **not a Yaro CLI command**. All Yaro commands continue to derive their
definitions, spelling and accepted behavior from the canonical Head. Changes
to Head require the user's approval and a separate verified generation.

## Implemented in the feature branch

- MCP Apps resource `ui://nestnyx/connections/v2.html` with tool
  `nyx_connections_panel` and ChatGPT UI compatibility metadata.
- The panel contains GitHub connection management plus a separate,
  **read-only private Rclone inventory** of configured Google Drive and MEGA
  remotes. Rclone names and logical area aliases are shown, without credentials,
  remote options, drive paths or file contents. Presence in configuration is
  **not** a live provider availability test. The Rclone inventory tool is
  absent in public multi-user mode and requires the private Auth0 subject.
- Only GitHub connections may be created in the panel. Old Heroku
  connections stay inert in the PostgreSQL database; no Heroku credentials
  or hosting access are granted by this integration.
- GitHub repo metadata, files, issues, pull requests, Actions logs, branches,
  commits and releases remain available with read-only scopes.
- Approved GitHub API mutations: `nyx_connection_github_branch_create`,
  `nyx_connection_github_commit_file`, `nyx_connection_github_draft_pr`,
  `nyx_connection_github_issue_create`. GitHub App tokens are minted for
  exactly one selected repository and one minimal permission.
- File mutations **only** target explicitly created `nyx/*` branches.
  Workflow, GitHub Actions, deployment, Heroku/Vercel configuration, broker,
  scripts and credential-file paths are blocked.
- Pull requests are always draft; no direct default-branch writes,
  merges, workflow dispatch, releases publishing, payments, billing,
  Git CLI, shell, Heroku API or Vercel API are exposed.

## Manual GitHub App permissions

Navigate to GitHub → Settings → Developer settings → GitHub Apps → NestNyx →
Permissions & events.

| GitHub App permission | Required |
| --- | --- |
| Metadata | Read-only (mandatory) |
| Contents | **Read and write** for staged code commits |
| Pull requests | **Read and write** for draft PR creation |
| Issues | **Read and write** for issues |
| Actions | Read-only for runs/logs |
| Workflows | **None** |
| Checks | Read-only if needed |
| Secrets | **None** |
| Administration | **None** |
| Deployments | **None** |
| Billing / Marketplace | **None** |

GitHub may ask you to approve the changed App permissions for existing
installations. Choose **Only select repositories** and install on the exact
repos you authorize. Do not grant app ownership of Heroku/Vercel or payment
systems. Manually review provider permission changes.

Existing NestNyx GitHub connections store verified grants from authorization
time. After expanding App permissions, disconnect/recreate and reauthorize
the pending NestNyx GitHub connection through the panel, if needed, to refresh
the provider grant snapshot; do not copy provider secrets into ChatGPT.

## Activation workflow

1. Inspect the source diff and green GitHub CI/tests on the feature PR.
2. Merge manually **only after review**. Nothing in this feature deploys apps.
3. Manually deploy the approved YaRoute `master` commit through the existing
   GitHub Actions Heroku workflow; this action still uses an owner-managed
   Heroku secret and must never be made automatically dispatchable by NYX.
4. Confirm `/health` reports the new commit and preserve
   `NYX_PRIVATE_OAUTH_SUBJECTS`, `DATABASE_URL` and OAuth settings.
5. In ChatGPT Settings → Plugins, refresh/reconnect NestNyx MCP at
   `https://dev-nest-nyx-0df80c227630.herokuapp.com/mcp`.
6. Invoke `nyx_connections_panel`. Authenticate via Auth0. Verify the
   **Rclone storage connections** section lists your configured Google Drive
   and MEGA remotes (no credential fields). If a remote does not appear,
   check the private Rclone configuration; do not paste credentials into chat.
7. Create a GitHub connection using the numeric installation ID; choose
   repositories and capabilities explicitly. Check that the UI renders.
8. First test a read and then an innocuous `nyx/*` review branch.
   Verify that direct default-branch changes are rejected.

**Separate trust boundaries:** the connected ChatGPT GitHub plugin already
has its own account permissions. That does not automatically alter the
NestNyx GitHub App. Only the GitHub owner can authorize App permissions.

**Not proved by code alone:** ChatGPT client discovery, MCP iframe rendering,
OAuth round trip, Neon metadata initialization, live App write grant, or
Heroku runtime deployment. Verify each after merging/redeploying.

## Rclone visibility and trust boundary

The new auxiliary tool `nyx_rclone_connections_list` (not a Yaro CLI
command) enumerates only `rclone listremotes --type drive --exact` and
`--type mega --exact` through the existing private `RcloneService`. The
result contains provider, remote name, optional configured area aliases and
`configured` status. It never reads files, provider account lists,
OAuth credentials, Rclone config text or quotas. In public mode the tool
is not registered and `StorageService.rcloneConnections()` fails closed.
Other Rclone provider types are intentionally omitted for now.
