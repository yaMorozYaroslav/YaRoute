# Tenant storage multi-connection and permission rollout (Dev proposal)

Status: **DESIGN / NOT YET IMPLEMENTED**. This document is a review gate, not permission to deploy, delete or upgrade grants. No production changes.

## User requirements

- Let a single authenticated OAuth owner enroll the same externally verified Google Drive or MEGA storage namespace multiple times under different connection IDs, labels, roots and separately encrypted credentials.
- Retain independent OAuth tenant isolation and prohibit sharing across the two ChatGPT identities merely because they refer to the same provider account.
- Expose adjustable permissions in the Connections panel. Support read, create/upload, rename, move, trash, and **explicit permanent deletion** where the provider, granted OAuth scopes, local policy and backend operations permit.
- Prefer the strongest eligible connection for a requested operation, **not** the most privileged connection unconditionally, and never select a connection owned by another OAuth identity.

## Existing constraints (inspect before implementation)

- `ConnectorsService.onModuleInit` creates `nyx_storage_verified_identity_v1` with `UNIQUE(owner_id, provider, namespace)`; both imported attestations and provider callbacks rely on this uniqueness. A duplicate currently fails with `STORAGE_DUPLICATE_DRIVE_ALREADY_CONNECTED`.
- `ConnectorsService.storagePermissions` and `storageResources` currently allow only `storage:list` for Google Drive; MEGA `storage:move`/`storage:delete` require `NYX_PUBLIC_MEGA_WRITE_ENABLED=true`.
- `TenantRcloneService` currently implements isolated MEGA `rename`, `move`, and `trash` only when enabled. It explicitly refuses hard delete. There is no exposed Google Drive write/move/delete tool. **Do not represent configuration toggles as working operations.**
- `nyx_connection_rename` and `nyx_storage_connection_rename` rename display labels only.
- Dev public tenant and Pro private legacy rclone remain separate. Pro has no provisioned tenant credential tables as of 2026-11-17.

## Phase 1: allow duplicates without weakening isolation

1. Write a reviewed, reversible migration to remove the *per-owner namespace* unique constraint. Preserve primary key `connection_id` and replace uniqueness with an ordinary index on `(owner_id, provider, namespace)`.
2. Update `attestImportedPendingStorageIdentity` and `confirmStorageProvider` so duplicate namespace acceptance is conditional on independently verified identity and current OAuth owner. Keep immutable association between one connection ID and its verified identity.
3. Do not deduplicate using display labels, emails, supplied remote names, hash of secrets, or root names.
4. Each connection retains unique encrypted credentials bound to `[ownerId, connectionId, provider, 'v2']` with its deployment-specific encryption key; do not reuse or transfer ciphertext.
5. Import by *connection ID*, with an explicit request to add another connection when a matching remote name already exists. Never overwrite a live record or unexpectedly reuse pending credentials.
6. Treat the same Google account with different scoped roots as separate connection resources. No cross-owner sharing or implicit permission inheritance.

## Phase 2: explicit permissions + capable operations

1. Add independent requested vs provider-verified vs effective capability display to Connections: `list`, `create/upload`, `rename`, `move`, `trash`, `permanent-delete`. Preserve separately versioned permissions per selected root and selected resource.
2. Do not infer full Drive scope from a saved token's local `scope = drive` string. Verify effective authenticated scopes via provider and reauthorize whenever the requested operation exceeds the existing credential's actual grant.
3. Implement isolated Google Drive operations with provider authorization, path/root confinement, no arbitrary rclone args, no cross-tenant tokens, strong preflight, immutable file ID checks and audit receipts. Define differing semantics for My Drive, shared drives, and `drive.file`-limited tokens.
4. Implement MEGA rename/move/trash behind explicit user and provider grants. Permanent delete is a *new separately reviewed action*; don't equate MEGA rubbish-bin delete or rclone `deletefile` with irreversible deletion.
5. Permanent deletion must be opt-in per connection and root, OFF by default; require item-specific confirmation token, exact identity/path/readback, separate policy grant, deterministic retry/idempotency, audit receipt, and protected paths/retention safeguards.
6. Display risk and reauthorization requirements in the panel; modifying desired capabilities must not make tools executable until provider scope and policy requirements independently pass.
7. Keep Pro and `YaRoute/master` unchanged until Dev tests, isolation, Pro-specific key/credentials and staged Tester approval pass.

## Phase 3: deterministic selection among duplicate connections

For a request `(oauthOwner, provider, verifiedNamespace, root, path, operation)`:

- Start with **only the current authenticated OAuth owner's** active connections. Verify exact namespace and resource/root grant from server-attested identity, not user-supplied email or display name.
- Filter out revoked, stale, unauthenticated, unverified, and insufficient-provider-scope records. Require both user-selected and provider-verified capabilities plus server policy to permit the operation.
- Verify source and destination are both authorized if move/copy spans roots. Refuse a cross-provider or cross-owner transfer unless an explicit separately reviewed transfer operation exists.
- Among eligible connections, choose greatest effective capability breadth (set inclusion); where grants are incomparable, use a deterministic documented capability score and stable connection ID tie-break. **Never choose a broader-scope connection if a narrower one is the only credential eligible for the exact root and operation.**
- If any authorization fact is missing, fail closed and show a permission-adjust/reconnect action; do not silently retry another owner's connection or escalate to legacy global credentials.
- On irreversible operations require confirmation of the selected connection and target, never an implicit privilege fallback.

## Verification gate

- Duplicate same account/same root and same account/different root under the same owner: independently enrolled and correctly selectable.
- Same provider account under two OAuth owners: isolated keys, rows, listings, and denied cross-owner access.
- Missing scope, revoked scope, different root, stale credential, pending connection: excluded from selection.
- Selection is deterministic across DB ordering and restart; no privilege escalation via rename or altered requested permissions.
- File creation/upload, rename, move, trash and irreversible delete integration tests for each provider. Test trash vs hard delete distinctly, exact preflight/confirmation, audit/recovery behavior and protected paths.
- Confirm current seven Dev read-only connections remain valid through database migration and that tests cover Pro's existing GitHub and bootstrap dependencies.
- No changes to `YaRoute/master`, Heroku runtime, Neon production tables or stored secrets without independent reviewed rollout.

## GitHub provenance audit

The existing GitHub connections have active GitHub App installation IDs and owner-bound records, but `nyx_connector_connections` has `updated_at` only, **no creation timestamp**. Current state alone cannot establish who originally completed the GitHub OAuth flow or the historical installation time. Inspect Auth0/GitHub App audit events for chronology; avoid claiming auto-consent.
