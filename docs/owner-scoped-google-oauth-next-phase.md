# NestNyx owner-scoped Drive OAuth and Rclone vault — staged next phase

This is a **review branch**, not a deployed service. Reuse the existing Neon PostgreSQL `DATABASE_URL`. Do not put credentials, OAuth secrets, access tokens, MEGA account passwords, recovery codes, or credential hashes in Git, Head or Body.

## Modes and authority boundary

**Private legacy NYX**: `NYX_DEPLOYMENT_MODE=private`, exactly one value in `NYX_PRIVATE_OAUTH_SUBJECTS`. Private Head/Yaro CLI, old Rclone roots, shared-file handoffs and operator tools work as they did before. This mode is **not multi-user safe**, even if it has multiple Google/MEGA remotes.

**Public connectors-only**: `NYX_DEPLOYMENT_MODE=public`, `NYX_PUBLIC_CONNECTORS_ENABLED=true`, `NYX_RCLONE_VAULT_ENABLED=true`, `DATABASE_URL`, `NYX_RCLONE_CREDENTIAL_KEY`. Any valid OAuth subject can manage *only their own* Neon GitHub/Google Drive connection records and optional account-specific read-only Google Drive Rclone probes. Public requests **cannot** execute legacy Rclone commands, enumerate the operator's remotes, access private shared roots, run transfers/indexing, or invoke Head/Yaro private tools. **Do not configure** `RCLONE_CONFIG_B64`, `RCLONE_CONFIG_PATH`, or global roots in the public connector runtime; the Heroku deployment preflight rejects global Rclone configuration.

The vault key is mandatory and cannot be safely invented in source code or regenerated at startup. Supply a persistent, securely backed-up 32-byte key in trusted hosting secrets. Rotating that key requires a planned re-encryption migration. Never transmit it through ChatGPT or commit it.

## Google Drive: user consent rather than credential pasting

Create a Google Cloud OAuth 2.0 **Web application** in the operator's Google Cloud project, publish/verify the required consent screen, and set its authorized redirect URI to exactly:

`https://<your-public-host>/connect/google/callback`

Set `NYX_GOOGLE_CLIENT_ID`, `NYX_GOOGLE_CLIENT_SECRET`, and an exact HTTPS origin `NYX_PUBLIC_URL` in trusted hosting configuration. The OAuth client secret is a runtime secret, **not** a GitHub variable in `config/heroku-public.json`.

Within the NestNyx MCP Apps panel, create a Google Drive account record and select **Authorize Google Drive (read-only)**. The owner-scoped start action creates a 10-minute single-use OAuth state stored in Neon, pairs it with PKCE S256, then opens Google's own consent page. The callback exchanges the code at a fixed Google token endpoint and requires an offline refresh token. It stores a single-remote Rclone profile sealed using AES-256-GCM with authenticated associated data: (owner, UUID, provider, remote). **No refresh token reaches ChatGPT, the panel, or the URL.**

The scope requested is `https://www.googleapis.com/auth/drive.readonly`. No Drive writes, deletes, transfers or full contents are exposed by the public connector tools. Rclone `about` success only proves a bounded probe worked; an unsupported probe remains unverified.

## Revocation and limitations

Unlink removes account-scoped credential ciphertext from Neon and marks the account revoked. For vault-managed Google Drive OAuth grants, the backend first makes a bounded best-effort token revoke request to Google's fixed endpoint. The result explicitly reports `externalRevocationRequired` on failure; NestNyx access is removed locally regardless of external status. The user may need to revoke app access directly from their Google Account if the network or provider denies the revoke request.

**Optional MEGA profile setup (disabled by default).** In public mode, MEGA connections use the same per-owner encrypted Rclone vault as Google Drive, but MEGA has no equivalent browser OAuth consent or standalone API key. A verified user first creates a pending MEGA connection in the panel. If the operator separately enables `NYX_MEGA_SELF_SERVICE_ENABLED=true`, the panel can generate a 10-minute, single-use owner-bound link to `/connect/mega/setup`. The HTTPS page explains how to create a MEGA remote locally with `rclone config` and paste **only that one Rclone remote section** (`type`, `user`, `pass`). Strict validation rejects unknown options, extra remote sections and one-time 2FA codes. The profile is encrypted immediately with AES-256-GCM in Neon under that OAuth owner; it is not sent through MCP or ChatGPT. Saving a profile is not proof of successful authorization; the user must run Test access. Existing operator MEGA remotes remain private and are not migrated or disclosed. When disabled, use trusted stdin provisioning. Revoking at NestNyx does not revoke the MEGA session at the provider.

This branch is **not yet fully general-purpose multi-tenant storage**. Public per-owner Rclone execution is limited to connection-bound, read-only probes. Legacy storage copying, writing, global indexing, shared jobs and canonical NYX operational tools remain private. A simplified MEGA direct-credential form, durable 2FA session handling, refresh-token rotation persistence, self-service write grants and end-to-end production OAuth/Neon tests are follow-up work.

## Release checks

- Pass GitHub Actions build, tests and GitGuardian security checks.
- Validate the current **actual Heroku runtime mode** before changing it. Changing an existing private NYX runtime into public connector-only mode would intentionally disable private CLI, job and shared-root operations. For simultaneous access, run separately isolated private and connector-only services or implement tool-by-tool authorization behind a verified security review.
- Keep the existing private deployment intact until public OAuth client, vault secret and Neon are provisioned and independently tested.
- Use a separately authorized manual operator deployment; the GitHub-to-Heroku deployment workflow was removed in PR #11. No deployment, plan scaling or paid add-on procurement is authorized by this pull request. Run release preflight privately, without sending hosting credentials to GitHub/ChatGPT. Verify release commit in `/health`, unauthenticated `/mcp` returns 401, OAuth state is one-time and owner-scoped, and a second user cannot list/test/revoke a different user's account.
- Do not assert live Google, MEGA or Neon integration is working until an actual live authorization and account probe succeeds.

Canonical Head/Body/Footer bundles remain independent; no Yaro core generation occurs as part of this repository change.

## Public Yaro command release gate — one application for everyone

The intended product is a single NestNyx app with one public Connections Panel and user-isolated Yaro command execution for all authenticated users, including the operator. Current canonical `nyx_execute`, `nyx_ini`, and `nyx_sum` depend on a private shared bootstrap, private Body/Footer path routing and private handoff resources. The current public MCP server intentionally does **not** register those command tools. Public capability discovery reports `blocked_pending_per_user_yaro_workspace` for them rather than claiming access.

A public Yaro release requires: (1) a verified, sanitized, unpacked **public Head** authority and immutable CLI definition; (2) owner-scoped Body/working data routing without process-global operator credentials; (3) owner-bound FIF/FIB/handoff persistence with no paths to operator archives or shared private state; (4) per-owner authorization and rate/resource limits on all commands and source reads; (5) two-user hostile tests proving no cross-account access and full private command isolation; (6) a manual, authorized deployment and live validation on the current Heroku plan. Do not turn on public mode on the existing operator instance until these checks pass; doing so removes private commands. Do not report command execution or a public deployment as available merely because the UI and auth code are present.

## MEGA secure setup page release checks

- Feature flag `NYX_MEGA_SELF_SERVICE_ENABLED` defaults OFF; do not enable before separate security review and manual deployment approval.
- The page accepts a **single local Rclone profile**, NOT a MEGA recovery key, vault encryption key, password field or raw multi-account config file. The user must generate the profile on their own computer.
- The setup form is HTTPS-only, has no external assets or scripts, returns `Cache-Control: no-store`, strict CSP and Referrer-Policy, and stores no secrets in the URL. The one-use URL state contains only random bytes; Neon stores its SHA-256 digest and owner/connection binding with ten-minute expiry.
- The setup route does not expose any encrypted vault key or bearer session in HTML. The server operator can decrypt vault profiles using the server-side key; this is **not end-to-end encryption**. Do not enable request-body logging in hosting, reverse proxies or APM.
- Test a real MEGA connection without 2FA and another user's account for isolation. Rclone quota probes can return `unverified` on an otherwise working remote. Do not present a saved profile as a verified connection.
- Repeated public MEGA connectivity probes are throttled atomically in Neon to at most one per owner/connection per three minutes to reduce MEGA login blocking. This does not create a reliable provider-side rate-limit guarantee, especially across user accounts with the same MEGA credentials.
- MEGA account passwords and 2FA/recovery codes must never be sent to ChatGPT. A profile may itself contain reversible obfuscated credentials; treat it as a secret. Leave existing private remotes untouched.
