# NestNyx connector implementation — manual activation checklist (2026-10-10)

Code branch: `master`. This file is a deployment guide, not evidence that
the production Heroku instance or any provider account has been configured.

## What is implemented in source

- Owner-scoped PostgreSQL connection management with custom names, permissions,
  repository/app resource restrictions, revocation, 12-connection owner ceiling,
  atomic 60 API reads/hour/owner limit and one-time OAuth state records.
- GitHub App web OAuth callback at `/connect/github/callback`; it exchanges
  authorization codes server-side, confirms the user can access the selected
  installation, verifies the installation belongs to the configured app,
  queries permitted repositories, and discards the user OAuth token.
- Short-lived GitHub installation tokens, restricted to ONE selected repository
  and a single required READ capability per request; read-only GitHub REST
  operations: repo metadata, issues, pull requests, bounded text file reads,
  workflows, runs and jobs. NO Git CLI, workflow dispatch, repo writes, shell.
- Heroku: app status and recent releases via externally isolated signed
  read-only broker. Local Heroku registration becomes active only after the
  broker independently authorizes the exact subject, connection ID and app.
- MCP tools plus UI resource `ui://nestnyx/connections/v1.html`. Tool
  `nyx_connections_panel` opens a working panel for adding, listing,
  renaming, changing API capabilities and resource selections,
  GitHub OAuth authorization, Heroku verification and disconnect.
- `NYX_DEPLOYMENT_MODE=public` with `NYX_PUBLIC_CONNECTORS_ENABLED=true`
  exposes ONLY connector tools and read-only risk-preview; it does not register
  old global Rclone/NYX handoff/CLI tools in public MCP.
- All financial/tariff/paid-provisioning operations remain forbidden.
  There are no payment credentials or billing APIs in these connectors.

**Not yet implemented:** GitHub/Heroku mutations, automated deploys, public
third-party installation verification, complete production traffic monitoring,
billing-based hard caps (must remain manual anyway), Google/MEGA per-user OAuth
migration, and publication or platform acceptance of the MCP Apps panel.
Do not claim the plugin UI is already visible until Heroku deploy and ChatGPT
connection has been tested end-to-end.

## Manual actions — do not give secrets to ChatGPT

1. **Database:** In existing Heroku `dev-nest-nyx` check whether `DATABASE_URL`
   already exists. Preserve its exact value; if missing, create PostgreSQL
   through Neon or a provider chosen manually, then set `DATABASE_URL`.
   DB role must have privileges to create metadata and OAuth state tables.
2. **Existing encryption:** Preserve `NYX_STORAGE_ENCRYPTION_KEY` if already set.
   If enabling public storage in this application for the first time, generate
   a cryptographically random 32-byte base64 key and keep it securely in
   Heroku only. Do not regenerate when encrypted data already exists.
3. **Existing NestNyx login OAuth:** Verify `NYX_OAUTH_ISSUER`,
   `NYX_OAUTH_AUDIENCE`, `NYX_PUBLIC_URL`, JWT scopes, callback handling.
   No need to create another identity provider solely for NestNyx login.
4. **GitHub App:** Under GitHub Developer settings, create (or reuse) a GitHub
   App for the NestNyx connector. Allow installation on the desired accounts,
   select ONLY specific repositories, and initially request read-only
   `Metadata`, `Contents`, `Actions`, `Issues`, `Pull requests`.
   Disable webhooks if unused; do not grant Actions write, secrets, workflows
   write, organization administration, billing, Marketplace or broad account access.
5. **GitHub App callback:** Configure the App's **User authorization callback**
   to `https://dev-nest-nyx-0df80c227630.herokuapp.com/connect/github/callback`
   if this remains your exact `NYX_PUBLIC_URL`. The setup URL is a separate
   mechanism; don't rely on unverified setup-url `installation_id`.
6. **GitHub App config in Heroku:** Set `NYX_GITHUB_APP_ID`,
   `NYX_GITHUB_CLIENT_ID`, `NYX_GITHUB_CLIENT_SECRET`, and
   `NYX_GITHUB_APP_PRIVATE_KEY_B64`. The final variable is the exact
   downloaded PEM private key encoded as ONE canonical base64 line, generated
   locally. Never place values in GitHub source files, NYX Head/Body,
   ChatGPT messages or frontend code. Rotating keys requires updating Heroku.
7. **GitHub installation:** Personally install your GitHub App on selected
   repos. Copy the numerical installation ID from the GitHub installation
   settings URL. In NestNyx panel choose GitHub, create a named pending
   connection, enter that ID and follow GitHub's OAuth link. Reopen the panel
   after the callback, select capabilities and resources, then read a repo
   metadata or CI endpoint to confirm.
8. **Heroku broker (optional, separate manual prerequisite):**
   Deploy `broker/heroku-readonly.mjs` yourself into a SEPARATE isolated,
   owner-controlled HTTPS runtime; do not grant NYX permission to deploy or
   rewrite its code. Configure that environment with `HEROKU_READ_OAUTH_TOKEN`
   with scope `read` ONLY (not `global`, `write`,
   `read-protected`), a distinct `NYX_HEROKU_BROKER_SHARED_KEY`
   (at least 32 random characters), and
   `NYX_HEROKU_BROKER_GRANTS_JSON` mapping exact OAuth owner IDs,
   connection UUIDs and allowed existing Heroku apps.
   Example non-secret structure:
   `{"oauth:subject":{"connection-uuid":["dev-nest-nyx"]}}`.
   Get actual subject and connection ID from `nyx_connections_list`.
   No token in NestNyx; broker projections exclude Heroku config values,
   payments and bills. Keep broker repo/hosting administratively outside NYX.
9. **Link Heroku broker to NestNyx:** After independently testing your broker,
   configure `NYX_HEROKU_BROKER_URL` (HTTPS origin) and the SAME
   `NYX_HEROKU_BROKER_SHARED_KEY` in the NestNyx app. Create a pending
   Heroku connection in panel and verify a manually authorized app.
   Select `heroku:apps:read` and `heroku:releases:read` for that app.
   All Heroku administration remains unavailable.
10. **Staging gate — preserve existing NYX:** Keep your CURRENT NestNyx
    installation in its existing PRIVATE mode, with its existing
    `NYX_PRIVATE_OAUTH_SUBJECTS` allowlist, so NYX initialization, FIF/FIB,
    Rclone storage and other old tools remain available. The new connector
    tools and panel coexist in private mode once database and app authorization
    are configured. Check CI and security audit on the deployed commit,
    verify owner isolation and one-time OAuth plus denied-resource tests.
    A FUTURE separate multi-user rollout can use
    `NYX_DEPLOYMENT_MODE=public` and
    `NYX_PUBLIC_CONNECTORS_ENABLED=true` after explicit approval and
    isolation testing. It will hide legacy shared credentials and commands;
    NEVER flip the current private NYX instance into public mode casually.
11. **Deployment:** From GitHub Actions manually dispatch the existing
    `Deploy to Heroku` workflow for `master`; it uses a GitHub Actions
    secret for Heroku deployment that must never become accessible to NYX
    through a GitHub App. Review the SHA, checks and target config first.
    Confirm `/health` commit hash matches and `/mcp` rejects unauthenticated
    requests; test the authenticated `nyx_connections_panel` tool.
12. **ChatGPT:** Reconnect/update your existing NestNyx plugin to the
    configured Heroku HTTPS MCP endpoint, authorize your account, and invoke
    `nyx_connections_panel`. Check actual UI render in ChatGPT before
    declaring it live. No custom paid domain is necessary for initial testing.

## Production release blockers

- No unaudited provider secrets in model context, logs or public repo.
- Finance-safe broker outside NYX control; independently configured
  provider-side budgets/spend alerts remain manual owner actions.
- No Git/Heroku shell or CLI, no generic provider HTTP proxy, no arbitrary
  URL/method tools. GitHub App tokens must remain short-lived, read-only,
  repo-limited, and user authorization must be verified.
- Multi-user and negative security tests, OAuth state replay tests,
  rate-limit tests, broker grants, revocation, error handling and callback
  probes must pass before allowing untrusted users.
- Test production deployment rollback without touching finances.
- Legacy Rclone/global storage MCP tools must never be exposed to public
  users; database and operational credentials must remain private.

## Implementation update — GitHub REST coverage and release boundaries

The GitHub read-only connector now additionally supports **branches, recent
commits on a selected branch, and release metadata**. These are available as
`nyx_connection_github_branches`, `nyx_connection_github_commits`, and
`nyx_connection_github_releases` MCP tools. The production user-selectable
API capabilities remain **read-only**: repository metadata, contents,
Actions inspection, issues, pull requests, and releases. Selecting a branch
restriction prevents unbounded branch enumeration and all calls require
matching user, GitHub installation, selected repository and capabilities.

The NestNyx **Connections Panel is implemented and registered in source** through
`nyx_connections_panel` and the MCP Apps UI resource. It has not been
verified visually in the live ChatGPT application until a manual, reviewed
Heroku deployment and plugin reconnection happen. Both GitHub and Heroku
brokers remain disabled without provider configuration.

Security tests cover branch/path restrictions, denial of cross-tenant GitHub
reads, OAuth installation and read-only token permissions, Heroku broker
denial of financial operations, the production API write-capability gate,
and the historical Git CLI denial.

**Do not grant the GitHub App repository Contents write, Actions write,
Workflows write, secrets access or administration rights for initial testing.**
The existing Heroku deployment workflow should remain manually dispatched.
No shell, Git CLI or Heroku CLI is exposed by new connectors.

Never share App ID/client secret/private-key PEM, Heroku OAuth token, OAuth
subject, broker secret, connection credential, Rclone config, or database
password through ChatGPT. Identifier values such as App ID may be non-secret,
but keeping all configuration within your own provider settings avoids mistakes.

The provider-billing and resource-sizing protections remain outside NestNyx
and under your personal manual control. Creating the separate Heroku broker
may itself incur infrastructure charges; choose and authorize its host
manually before provisioning anything.
