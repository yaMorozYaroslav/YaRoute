# NestNyx Head-governed CLI and Connections Panel v3

## Canonical command boundary

- Current **running** bootstrap reported `head_db_v028.zip`, CLI `v004`, content SHA `70e8cd6a1e4c52c2a21145ab02cdccb36ceab5f1fcb0f368d32acaa4e8b6c1c4`. This reference is informational, not a new canonical pointer.
- The independently inspected Head v028 archive contains 21 `LEAD/Core_Skills/YaRoCLI/nyxcli.json` command definitions. Each has a nonempty `purpose`.
- On every changed authority load, `NyxCliRegistryService` now rejects the **whole** CLI if any defined command has no meaningful `purpose` (minimum eight trimmed characters). A runtime execution profile cannot supply or override this Head description.
- Existing resolution then demands a typed execution contract. Undescribed or unsupported commands are not dispatchable through `nyx_execute`; `nyx_ini` and `nyx_sum` remain wrappers over the same canonical resolver. No new Yaro command has been added.
- Do not infer current authority from the largest-numbered ZIP on Drive; resolve the canonical bootstrap and verify its hash.

## Important distinction: transport and infrastructure endpoints

The above is a strict **Yaro CLI** gate. It does **not** mean that all NestJS HTTP routes or MCP auxiliary tools appear in the Head command table. Required `/health`, `/mcp`, OAuth metadata/callback, internal storage endpoints, and MCP Apps connection tools are infrastructure and still have separately documented interfaces. Do not present them as Yaro CLI commands or invent Head semantics.

Enforcing *literal Head allowlisting of every HTTP/MCP endpoint* would need a separately generated and promoted, machine-readable Head endpoint registry and an explicit treatment of required transport and auth endpoints. This change does not silently rewrite canonical Head or shut down working transport.

## Connections Panel v3

MCP Apps resource: `ui://nestnyx/connections/v3.html`. Entrypoint: `nyx_connections_panel`.

- **GitHub:** Existing owner-scoped GitHub App authorization, per-repository permissions, review-branch code writes, draft PRs and issues. No default-branch writes, merge, workflow dispatch, secrets or billing APIs.
- **Rclone:** Existing private Google Drive/MEGA remote inventory, plus a per-remote **Test access** action. The MCP Apps-only `nyx_rclone_connection_test` tool calls bounded `rclone about remote:`, discards all provider output and returns only `reachable` or `unverified` with a safe error code. `unverified` can also mean that the backend does not support `about`.
- The Rclone probe is **private-only** and requires a bound OAuth owner. Inputs must be an existing typed configured remote; public multi-user mode rejects it. No filesystem listings, password fields, token exposure, config edits, provider link/unlink or remote deletion.
- Provider remote creation, reauthorization and true credential revocation are **not implemented**. The private process-wide `RCLONE_CONFIG_B64` bootstrap is unsuitable for ad hoc UI mutation or per-user credential control. That requires a separate secure, persistent credentials lifecycle with owner approval and verification before release. Never write live credentials into PRs or ChatGPT.

## Activation / verification

1. Review and merge the code via an approved PR; do not silently deploy.
2. Manually dispatch the existing owner-managed `deploy-heroku.yml` workflow.
3. Verify `/health.commit` matches the intended deployed commit.
4. Refresh the NestNyx MCP connection and open the **v3** panel.
5. Confirm authenticated GitHub operations and Rclone inventory; test a non-critical Rclone remote. Confirm public mode rejects the private tool and that no secrets appear in responses.
6. Treat missing app rendering, grants, backend deployment or OAuth as `UNVERIFIED`, not success.

## Existing Neon/PostgreSQL multi-account template (this PR)

The backend uses its existing `DATABASE_URL`, which may point to the owner's existing Neon project; it does **not** create or provision another database. This code change does not verify the contents of Neon, its connection string, or whether the running Heroku app currently has a healthy DB connection.

The existing `nyx_connector_connections` table is the single metadata registry for both GitHub and private Rclone account references. It already stores immutable `id`, `owner_id`, `provider`, `display_name`, `external_account_id`, capabilities, resource restrictions, status and modification time. This PR adds a partial unique index on `(owner_id, provider, external_account_id)` for non-revoked Rclone references. Therefore, one OAuth owner can link multiple distinct Google Drive and MEGA remotes and give each its own label, while duplicate active bindings of the same remote are rejected. Previously revoked records remain historical, and legacy `nyx_user_connections` fixed slots are **not** auto-migrated or deleted.

The panel supports **Link account**, **Rename**, **Test access** and **Unlink** for private Rclone references. `nyx_rclone_connection_link` persists a metadata row after verifying that the selected remote is in the currently configured private inventory. `nyx_rclone_connection_test` now accepts an **owned connection ID** instead of an arbitrary remote name and reads the provider and remote from the owner's persisted row. `nyx_connection_disconnect` revokes the owner record, but does **not** remove a remote from `rclone.conf` or revoke its provider credential. New bindings have `pending` status, empty effective/provider capabilities and zero selected resources; configured does **not** mean provider OAuth granted.

### Separation of identity and secrets

- Every MCP operation obtains its owner from verified OAuth JWT context; callers cannot set an `owner_id`. Repository queries and mutations are owner-scoped.
- This is a **private, single-operator Rclone model**. Multiple accounts are for the same trusted operator. In the current runtime, Rclone credentials and roots are process-wide, so distinct allowed OAuth subjects must not be treated as isolated storage tenants. True public multi-user Rclone remains disabled.
- Database rows contain only remote names and metadata. No Rclone config, tokens, passwords or encryption keys are written into Neon. The existing `StorageConnectionsService` encrypted fixed-slot schema is retained for compatibility, not used by this feature.
- Full multi-tenant operation must first implement per-user encrypted provider credentials, per-user Rclone config execution, owner-bound jobs, migration of legacy tools, and reviewed credential rotation/revocation. Do not lift the public Rclone rejection gate before these are verified.
- A database URL alone does not grant provider authorization, restore deleted credentials, or establish tenant isolation.

### Acceptance checks

1. Existing `DATABASE_URL` points to the intended Neon database; verify manually on the deployed app without disclosing its value.
2. PostgreSQL table/index migration completes without overwriting existing rows.
3. Two Rclone remotes of the same provider are stored under distinct stable IDs; owner-scoped list and rename/test/revoke are verified.
4. An OAuth subject cannot operate on a connection ID owned by another subject.
5. Public mode rejects operator-wide Rclone linking and probes; configured-only provider status is not represented as verified OAuth.
6. After approved deploy, verify `/health.commit`, panel v3 UI, GitHub API behavior, database rows and private Rclone probe.


## Opt-in per-connection encrypted vault and isolated Rclone probe

The private runtime now contains an **optional, disabled-by-default** credential isolation path:

- `NYX_RCLONE_VAULT_ENABLED=true`: switches linked-account probes to owner-bound encrypted profiles **without fallback** to process-wide Rclone credentials. New account references may be created before provisioning. The public multi-user Rclone runtime is still disabled.
- `NYX_RCLONE_CREDENTIAL_KEY`: independently managed 32-byte symmetric AES-GCM key, supplied as canonical base64 in the trusted server environment. Never commit, transmit in chat, put in Head/Body, or expose in logs. Store a recoverable backup using your own secure secret-management process; the current implementation does not automate key rotation.
- Existing `DATABASE_URL`: provisions the optional `nyx_rclone_credential_vault` table alongside the existing `nyx_connector_connections` table in your **existing Neon PostgreSQL**, with no new database or external paid infrastructure.
- Stored ciphertext is authenticated using the tuple `(OAuth owner, connection UUID, provider, remote name)`; exact-owner SQL selects are also joined against a non-revoked connection row. The vault validates that incoming Rclone config has exactly one matching Drive/MEGA remote profile.
- `scripts/provision-rclone-account.mjs`: **trusted server-side only**. Reads one profile over stdin and stores it after verifying the owner/connection/provider/remote match. This is deliberately **not** an MCP input, HTTP endpoint or credential text field. Provider OAuth setup and profile acquisition remain manual and outside ChatGPT.
- `RcloneService.probeIsolated`: runs only a bounded `rclone about` command, with a private temporary `0600` configuration file, a restricted subprocess environment, sanitized boolean result, and guaranteed local cleanup. No copies, deletes or indexing are permitted in this path.
- `McpAuthService` now **fails closed in private mode unless `NYX_PRIVATE_OAUTH_SUBJECTS` contains exactly one unique subject**. This is necessary because the legacy storage and NYX handoff routes are still process-wide. In public connector-only mode, multi-subject GitHub access continues to use owner-scoped APIs with no Rclone routes.

### Safe release sequence

1. Review the GitHub PR and run complete CI. Confirm the **one-subject private OAuth allowlist** before shipping or you can intentionally lose private MCP access.
2. Verify the existing Neon `DATABASE_URL` works in the target runtime; the PR cannot inspect or configure it. Do not publish it.
3. Configure an independently managed `NYX_RCLONE_CREDENTIAL_KEY` in private hosting secrets. This is a new secret value to manage; it is never provided to ChatGPT.
4. Add a pending connection in the panel for each target Google Drive/MEGA account. In the trusted server shell, provision its single-remote Rclone config using the stdin-only operator script, never through GitHub, MCP, shell argv or chat.
5. **Only after every required profile is available**, enable `NYX_RCLONE_VAULT_ENABLED=true`. An unprovisioned account will show `ISOLATED_CREDENTIAL_NOT_PROVISIONED`; the old shared configuration is never used as a fallback.
6. Merge and deploy manually through the existing deployment workflow after approval; verify `/health.commit`, private OAuth, panel v3, correct owner linkage, encrypted vault reads, local temp cleanup, and negative cross-owner probes. There is no automatic deploy in this PR.

### Deliberate limits

- No user-facing credential form, managed Google OAuth, MEGA password exchange, provider unlink/revocation, remote write, transfer or token refresh persistence.
- No public-mode Rclone access, and no claim that existing process-wide legacy storage tools have become tenant-isolated.
- The encrypted vault is a controlled internal foundation, **not** a complete self-service per-user storage OAuth implementation.
- Existing staged H29/B25/F82 files do **not** replace canonical H28/B24/F80 until the Yaro CAN lifecycle verifies and promotes them.
