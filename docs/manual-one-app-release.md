# NestNyx — manual one-app deployment runbook (draft, not authorization)

**Target:** existing Heroku application `dev-nest-nyx`; one public ChatGPT Connections Panel, owner-isolated Google Drive OAuth and optional MEGA Rclone profiles, and eventually owner-isolated Yaro command execution.

## Status and hard stop

This runbook does **not** mean the release is ready to deploy. This multi-user branch is not merged or deployed. Do **not** switch the existing private app to `NYX_DEPLOYMENT_MODE=public` until issue #13 is closed and tested: public-mode Yaro `ini`/`sum`/`execute` currently have **no owner-isolated execution path** and are intentionally unregistered. Turning on public mode now disables private Yaro features. Do not turn on GitHub Actions Heroku deployment, restore `HEROKU_API_KEY`, create a second billable app, scale dynos, or add paid add-ons.

## Code and configuration verification

1. Review and pass all checks on PR #9 followed by PR #10. PR #10 is stacked on PR #9. Review the actual diff and merge only after release gates pass.
2. Using the Heroku Dashboard (operator only), verify the app is `dev-nest-nyx`, its plan/add-ons/scale are unchanged, and the current Git source, buildpack and env var names are what you expect. Record the current release identifier for rollback.
3. Independently verify `https://<actual-existing-host>/health` reports `ok: true` and the expected `commit`. Do not assume a green GitHub CI means the running Heroku app is updated.
4. Keep `DATABASE_URL` and the persistent Base64 32-byte `NYX_RCLONE_CREDENTIAL_KEY` in Heroku Config Vars, not in GitHub or ChatGPT. Keep a secure backup of the key. Rotating it without re-encrypting vault records loses access.
5. Google Drive uses a Web application OAuth client with the exact `https://<actual-host>/connect/google/callback` redirect; set `NYX_GOOGLE_CLIENT_ID` and `NYX_GOOGLE_CLIENT_SECRET` in Heroku secrets, verify the OAuth consent screen is configured for the intended users, and preserve the private operator's existing credentials.
6. Verify `NYX_OAUTH_ISSUER` and `NYX_OAUTH_AUDIENCE` against the configured authenticated MCP server; user identity must be a **verified** OAuth subject. The audience points to `https://<actual-host>/mcp`. Test users must not share a bearer token.
7. Run `scripts/private-release-conditions.mjs` using a private local input source. The release validator reports only generic failures; don't print real secrets in shell history, CI, logs or ChatGPT.
8. For an initial private-mode app test, preserve exactly one `NYX_PRIVATE_OAUTH_SUBJECTS`, `NYX_DEPLOYMENT_MODE=private`, and all existing shared Rclone env/config. This is **single-user only**, never a public test.
9. With your **existing private owner** authenticated, turn on vault storage using the already backed-up `NYX_RCLONE_CREDENTIAL_KEY`; optionally set `NYX_MEGA_SELF_SERVICE_ENABLED=true` to trial the encrypted MEGA setup form. The flag defaults to disabled. Test from the actual ChatGPT panel and `Test access`, and verify credentials do not enter logs.
10. The panel's public MEGA setup form is `/connect/mega/setup?state=<one-time-random-link>`; it is reachable only after a signed-in user creates a MEGA connection through MCP and requests a 10-minute link. **No static shareable setup link exists.** The user can now enter their MEGA email/password directly through the NestNyx HTTPS form; the backend invokes `rclone obscure -` through stdin and encrypts a single remote profile in the owner vault. Advanced users may instead paste their existing single Rclone profile. The Rclone-obscured password is reversible; only the server-side AES-GCM vault protects the stored profile. Never request MEGA API/recovery keys, recovery codes, or passwords in ChatGPT. 2FA setup is not supported by this MVP.
11. Before **any multi-user** change, implement and verify issue #13's owner-bound Yaro workspace and command adapters; confirm a fresh test user cannot read the operator's Head/Body/Footer, private Rclone config, FIF/FIB, or write any other user's records. User A and B must have different encrypted vault records and distinct Google Drive OAuth consents. Public MEGA probe calls have an atomic 3-minute cooldown.
12. A public-mode deployment may only proceed **after** the operator's needed MEGA profiles are securely re-provisioned into their owner vault and verified, and the existing shared `RCLONE_CONFIG_B64`, `RCLONE_CONFIG_PATH`, process-global roots, and private-source locators are no longer accessible to other tenants. A private-only Rclone configuration CANNOT remain usable through the public multi-user executor. Do not delete the old backup prematurely.
13. Deploy manually only from a reviewed verified commit using an explicitly approved Heroku Dashboard deployment or authenticated Heroku CLI, **not GitHub Actions or a GitHub-hosted Heroku API key**. Deployment is not automatic. Obtain explicit approval for any plan/billing change.
14. After deploy, recheck exact commit, OAuth challenge for unauthenticated `/mcp` (expect 401), ChatGPT tool refresh, Google callback, MEGA one-time URL replay rejection, and cross-owner denial for list/test/unlink. Verify private Yaro commands work only when authorized and public commands have no shared data paths.
15. If tests or operator workflow fail, roll back the Heroku release through the Dashboard, restore the previous mode/configuration, and confirm the old private Rclone and Yaro tooling are usable. The encrypted vault and Neon records persist across code rollbacks; never discard its key.

## Deployment blockers as of this draft

- Public Yaro `nyx_execute`, `nyx_ini`, `nyx_sum` require per-user workspace and sanitized public Head authority (issue #13).
- No verified Heroku deployment mechanism with current GitHub connector; GitHub Actions is CI-only.
- No live production Google/MEGA authorization or multi-user negative test has completed.
- No MEGA self-service 2FA workflow.
- This checklist is a planned release procedure, **not** proof of a completed deployment or that extra Heroku usage will have zero cost.

## MEGA direct-credential form and permissions

- The one-time link now displays MEGA email/password inputs and an optional advanced local Rclone profile field. No MEGA recovery key or vault encryption key is requested.
- The form explains that the operator owns the server-side vault key and can decrypt stored credentials. This is **not end-to-end encryption**.
- The `read` or `manage` choice is saved as an **intention** in an owner-scoped Neon table. Bounded, owner-authorized read-only cloud folder browsing (max 50 names per request, 30 calls/hour per owner/connection) and Rclone connection probes are implemented. Selecting manage does not enable any write/upload/delete tool. Do not advertise manage as an active ability until separate APIs enforce the requested permissions.
- MEGA connections become `active` only if a provider-side read-only `lsf` check succeeds. This is rate limited across dynos. Direct web-form MEGA 2FA is not supported yet.
- Before turning on `NYX_MEGA_SELF_SERVICE_ENABLED=true`, manually check HTTPS, disabled request-body logs, single-use links, current deployment SHA, and trial with a disposable MEGA account. No live credentials have been requested in this repository.

## When to reconnect

Do **not** reconnect while the current Heroku release still runs the old build. After manual operator deployment, verify `/health` reports the release SHA, confirm authenticated ChatGPT tools include `nyx_connections_panel`, `nyx_rclone_connection_begin_google`, `nyx_rclone_connection_begin_mega`, and `nyx_rclone_connection_ls`, then reconnect Google Drive via the panel's OAuth button and MEGA using its ten-minute secure setup form. Run `Test access`, refresh, and use `Browse folder` on the active account. Never paste credentials into ChatGPT.

A private-mode deploy may allow **the existing single operator** to trial these tools without migrating canonical Yaro. It does **not** authorize multiple users. Public Yaro `ini`/`sum`/`execute` remain blocked until owner-bound workspace isolation has passed independent review and tests (issue #13). Do not represent private-mode trials as a public release.

## Two-phase rollout on the SAME Heroku app — concrete operator steps

### Phase A — private backward-compatible pilot (next manual deploy)

- **Do not switch to public mode yet.** Keep `NYX_DEPLOYMENT_MODE=private`, the one verified private OAuth subject and the existing `RCLONE_CONFIG_B64`/path in Heroku. Existing MEGA and Drive remotes remain a rollback mechanism. Verify the old private commands first.
- In your existing Google Cloud project, create/reuse a **Web application** OAuth client with authorized redirect `https://dev-nest-nyx-0df80c227630.herokuapp.com/connect/google/callback`. Keep your original Desktop `rclone-client` unchanged. Verify the consent screen allows your account. Store the Web client ID and secret as Heroku `NYX_GOOGLE_CLIENT_ID` and `NYX_GOOGLE_CLIENT_SECRET`; never commit them.
- Preserve `DATABASE_URL` and your existing backed-up `NYX_RCLONE_CREDENTIAL_KEY` (Base64 32-byte) in Heroku Config Vars. Add `NYX_RCLONE_VAULT_ENABLED=true`, `NYX_PUBLIC_URL=https://dev-nest-nyx-0df80c227630.herokuapp.com`, and `NYX_MEGA_SELF_SERVICE_ENABLED=true` only after the exact reviewed code is being deployed. Do not rotate keys or paste them in chat.
- The operator must manually deploy the reviewed release through their existing Heroku deployment route, since the GitHub-to-Heroku Actions workflow has been removed. **No manual redeploy should happen until reviewed PR #9 and stacked PR #10 have passed checks and the operator has a rollback point.** Heroku deployment can restart the current running app; do not promise zero downtime.
- After Heroku reports success, open `/health` and check the **exact running commit**, `connectorRelease.mode=private_compatibility`, `panelRegistered=true`, `googleOAuthConfigured=true`, `ownerVaultConfigured=true`, `megaFormEnabled=true`, `multiUserYaroReady=false`. These fields are configuration evidence, NOT proof of external provider authorization.
- Refresh the NestNyx plugin's tools in ChatGPT, open `nyx_connections_panel`, link **your** Google Drive via Google's own consent URL, and link **your** MEGA through the one-time NestNyx HTTPS email/password form (or advanced one-remote profile). Use `Test access` and a bounded folder browse for each. Read-only file browsing is the only owner-vault file operation currently implemented; the `manage` selection is a future request, not write authority.
- If live login or browsing fails, leave the legacy private Rclone settings intact and roll the Heroku release back. Do not try to debug by sharing passwords, tokens, recovery codes, or full Rclone profiles in ChatGPT.

### Phase B — public multi-user activation (NOT READY)

- Finish [Yaro owner-scoped workspaces](https://github.com/yaMorozYaroslav/YaRoute/issues/13) and hostile cross-user tests, or explicitly agree to release public connectors **without** any Yaro commands. The current user requirement is Yaro CLI for everyone, so no public activation is authorized until that requirement is met.
- After verified secure migration and an encrypted rollback backup, **unset** `RCLONE_CONFIG_B64`, `RCLONE_CONFIG_PATH`, `NYX_SHARED_ROOTS_JSON` and any other shared operator source locators **before** setting `NYX_DEPLOYMENT_MODE=public`. The current public backend now refuses to start with shared Rclone credentials still configured. Public users use encrypted owner-bound Neon vault records, never process-global remotes.
- Re-check `/health.connectorRelease.mode=public_connectors_only`, live OAuth/MEGA accounts for two distinct authenticated users, unauthorized access denial, and per-user CLI source isolation **before** announcing public availability. Do not remove the encrypted legacy backup until real rollback and continuity checks pass.

**Important:** The new user experience retires the need for **users to configure Rclone themselves**. Internally, MEGA still uses the Rclone executable for now. A genuinely Rclone-free MEGA backend is a separate project; do not assert Rclone has been fully removed.
