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
- The `read` or `manage` choice is saved as an **intention** in an owner-scoped Neon table. Only read-only Rclone probes are implemented. Selecting manage does not enable any write/upload/delete tool. Do not advertise manage as an active ability until separate APIs enforce the requested permissions.
- MEGA connections become `active` only if a provider-side read-only `lsf` check succeeds. This is rate limited across dynos. Direct web-form MEGA 2FA is not supported yet.
- Before turning on `NYX_MEGA_SELF_SERVICE_ENABLED=true`, manually check HTTPS, disabled request-body logs, single-use links, current deployment SHA, and trial with a disposable MEGA account. No live credentials have been requested in this repository.
