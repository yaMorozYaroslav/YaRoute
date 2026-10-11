# NestNyx owner-scoped Drive OAuth and Rclone vault — staged next phase

This is a **review branch**, not a deployed service. Reuse the existing Neon PostgreSQL `DATABASE_URL`. Do not put credentials, OAuth secrets, access tokens, MEGA account passwords, recovery codes, or credential hashes in Git, Head or Body.

## Modes and authority boundary

**Private legacy NYX**: `NYX_DEPLOYMENT_MODE=private`, exactly one value in `NYX_PRIVATE_OAUTH_SUBJECTS`. Private Head/Yaro CLI, old Rclone roots, shared-file handoffs and operator tools work as they did before. This mode is **not multi-user safe**, even if it has multiple Google/MEGA remotes.

**Public connectors-only**: `NYX_DEPLOYMENT_MODE=public`, `NYX_PUBLIC_CONNECTORS_ENABLED=true`, `NYX_RCLONE_VAULT_ENABLED=true`, `DATABASE_URL`, `NYX_RCLONE_CREDENTIAL_KEY`. Any valid OAuth subject can manage *only their own* Neon connection records and optional account-specific read-only Rclone probes. Public requests **cannot** execute legacy Rclone commands, enumerate the operator's remotes, access private shared roots, run transfers/indexing, or invoke Head/Yaro private tools. **Do not configure** `RCLONE_CONFIG_B64`, `RCLONE_CONFIG_PATH`, or global roots in the public connector runtime; the Heroku deployment preflight rejects global Rclone configuration.

The vault key is mandatory and cannot be safely invented in source code or regenerated at startup. Supply a persistent, securely backed-up 32-byte key in trusted hosting secrets. Rotating that key requires a planned re-encryption migration. Never transmit it through ChatGPT or commit it.

## Google Drive: user consent rather than credential pasting

Create a Google Cloud OAuth 2.0 **Web application** in the operator's Google Cloud project, publish/verify the required consent screen, and set its authorized redirect URI to exactly:

`https://<your-public-host>/connect/google/callback`

Set `NYX_GOOGLE_CLIENT_ID`, `NYX_GOOGLE_CLIENT_SECRET`, and an exact HTTPS origin `NYX_PUBLIC_URL` in trusted hosting configuration. The OAuth client secret is a runtime secret, **not** a GitHub variable in `config/heroku-public.json`.

Within the NestNyx MCP Apps panel, create a Google Drive account record and select **Authorize Google Drive (read-only)**. The owner-scoped start action creates a 10-minute single-use OAuth state stored in Neon, pairs it with PKCE S256, then opens Google's own consent page. The callback exchanges the code at a fixed Google token endpoint and requires an offline refresh token. It stores a single-remote Rclone profile sealed using AES-256-GCM with authenticated associated data: (owner, UUID, provider, remote). **No refresh token reaches ChatGPT, the panel, or the URL.**

The scope requested is `https://www.googleapis.com/auth/drive.readonly`. No Drive writes, deletes, transfers or full contents are exposed by the public connector tools. Rclone `about` success only proves a bounded probe worked; an unsupported probe remains unverified.

## Revocation and limitations

Unlink removes account-scoped credential ciphertext from Neon and marks the account revoked. For vault-managed Google Drive OAuth grants, the backend first makes a bounded best-effort token revoke request to Google's fixed endpoint. The result explicitly reports `externalRevocationRequired` on failure; NestNyx access is removed locally regardless of external status. The user may need to revoke app access directly from their Google Account if the network or provider denies the revoke request.

**MEGA is not Google OAuth.** This branch deliberately does **not** collect MEGA passwords or sessions through MCP/ChatGPT. MEGA accounts can be created as pending references and provisioned by the trusted operator over stdin into the vault. Removing a MEGA account revokes NestNyx's local encrypted credentials, but account-session invalidation at MEGA must be handled separately.

This branch is **not yet fully general-purpose multi-tenant storage**. Public per-owner Rclone execution is limited to connection-bound, read-only probes. Legacy storage copying, writing, global indexing, shared jobs and canonical NYX operational tools remain private. A provider-specific MEGA login flow, refresh-token rotation persistence, self-service write grants and end-to-end production OAuth/Neon tests are follow-up work.

## Release checks

- Pass GitHub Actions build, tests and GitGuardian security checks.
- Validate the current **actual Heroku runtime mode** before changing it. Changing an existing private NYX runtime into public connector-only mode would intentionally disable private CLI, job and shared-root operations. For simultaneous access, run separately isolated private and connector-only services or implement tool-by-tool authorization behind a verified security review.
- Keep the existing private deployment intact until public OAuth client, vault secret and Neon are provisioned and independently tested.
- Run the secret-safe GitHub deploy preflight before any deployment. Verify release commit in `/health`, unauthenticated `/mcp` returns 401, OAuth state is one-time and owner-scoped, and a second user cannot list/test/revoke a different user's account.
- Do not assert live Google, MEGA or Neon integration is working until an actual live authorization and account probe succeeds.

Canonical Head/Body/Footer bundles remain independent; no Yaro core generation occurs as part of this repository change.
