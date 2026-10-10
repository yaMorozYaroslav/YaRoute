# NestNyx connectors + Yaro CLI: implementation contract (proposal)

This is a **GitHub code-side design**, not a canonical Head/Body/Footer modification. The newest valid Head controls Yaro command names and semantics. A connection user's choices never redefine the canonical CLI.

## What the user configures in ChatGPT's NestNyx connection manager

1. **Provider:** Google Drive, MEGA, GitHub or eventually GitLab (only available when adapter works).
2. **Display name:** fully user editable, nonempty; names unique per user, case-insensitively. Each connection has an immutable ID independent of the label.
3. **Permissions:** selectable, granular operations; no default rights or automatic write grant.
4. **Resources:** explicit drive/folder, MEGA root, or repository selections. Optional folder path prefix and exact allowed Git branches. No selection means no usable resource access.
5. **Verification:** provider grant status, effective permissions, last verification, and pending additional consent, plus connect/reconnect/revoke.

On Add Connection, a placeholder can be prefilled from the old names:
Google: `google_main`, `google_work`, `google_a`, `google_b`, `google_c`, `google_d`;
MEGA: `mega_main`, `mega_work`; GitHub: `GitHub`.
**These are editable suggestions only. They do not imply default permissions, preselect accounts or assign any storage root.**
Existing legacy roots retain their old behavior until explicit verified migration.

## Current runtime inventory (repo verified)

| Operation family | Actual current implementation | User-scoped connector state |
| --- | --- | --- |
| Google/other Rclone remote list/stat/capacity | `StorageService`, `RcloneService`, `SharedRootsService` | operator-wide legacy, migration required |
| Google/other copy file with readback/owner checks | `StorageService.executeCopy` | operator-wide legacy; destination clobber protected |
| MEGA accounts/list/stat/capacity | MCP storage methods | operator-wide legacy; MEGA copy/move intentionally disabled |
| Global file index | queued job in `JobStoreService`; existing Rclone scan | operator-wide legacy, must isolate per owner |
| NYX `ini`, `sum`, `execute`, FIF/FIB | MCP + Head-resolved command executor | existing identity model; full public isolation incomplete |
| NYX KEY `oF` / `oS` | KEY library and disabled-by-default HTTP route | not publicly enabled |
| GitHub CI workflows/runs/jobs | `GithubReadonlyConnector` library | scoped authorization now required; no live MCP wiring |
| Git clone/fetch/status/diff/branch/commit/push/tag | `git-operations.ts` typed permission planner | **not executed**; dedicated worker required |
| PRs, issues, releases, CI dispatch | operation catalog only | not implemented |

`operation-catalog.ts` provides truthful status metadata to the future plugin panel: `legacy`, `canonical`, `disabled`, `prototype`, `planned`. It is **not** an execution mechanism.

## Command dispatch

```text
ChatGPT / NestNyx MCP
  -> verified OAuth subject + consent
  -> canonical Head command resolver (Yaro language)
  -> typed operation contract (capability, resource, risk, args)
  -> authenticated user's connection ID
  -> user's enabled permissions AND provider-granted permissions
  -> selected resource / folder / branch / repository boundary
  -> approval gate for remote writes or destructive operations
  -> provider adapter (Google APIs / Rclone / GitHub APIs)
     OR restricted Git worker, never arbitrary bash
  -> verification (commit SHA, diff, provider object checksum)
  -> owner-bound audit + durable receipt + status
```

A user's permission toggle cannot mint OAuth scopes, change GitHub App installation permissions,
override protected branches, read another user's connection, or bypass Head canonical rules.

## Git CLI worker requirements

- Use the GitHub App installation flow; obtain short-lived tokens, restricted to the selected repository IDs and required permissions. Git HTTPS accepts an installation token with Contents access; **do not put tokens in remote URLs, argv, logs, Git config or stdout**.
- A dedicated disposable workspace per job and per user, owned by an unprivileged isolated process/container. Never execute repository code, hooks, filters, Git aliases, arbitrary shell, submodules or custom external protocols by default. Disable credential helpers and inherited user/global Git config; allow GitHub HTTPS only.
- Allowlisted typed actions: inspect/status/log/show, clone, fetch, diff, create branch, commit, push and tag. Argument arrays are built server-side from validated references; no raw Git command string from the model or user.
- `git:push` additionally requires user permission + provider Contents write + repo/branch grant + explicit approval + expected remote HEAD/fast-forward verification. No force push or destructive ref deletion in the initial implementation.
- GitHub APIs handle PRs, issues, releases, Actions logs/dispatch. Map distinct API grants and results rather than treating them as Git CLI subcommands.
- Limit network hosts, CPU, memory, disk, output sizes, job duration, concurrency and number of retries; redact all tokens; persist audit records without credentials. Use an external isolated worker as needed because the Heroku web process is not a strong sandbox.
- `git-operations.ts` currently only validates a planned action and returns `executable:false`. **Do not expose it as a functioning CLI executor.**

## Connection creation / authorization

Persist metadata with per-user uniqueness in PostgreSQL. Never accept `ownerId` or
`providerCapabilities` from an untrusted MCP tool payload. Derive owner from verified
OAuth context and provider grants from a server-side token verification process. Encrypt
refresh tokens/credentials with a separate encryption key and bind ciphertext to owner
and connection ID. GitHub installation IDs alone are **not** proof that an OAuth subject
can act for that installation; validate installation/repository membership against the
user's authenticated GitHub identity.

Public mode is **not ready**: `RcloneService.onModuleInit` currently rejects public mode,
and `McpService.handle` rejects public storage mode. Do not bypass these guards until all
HTTP, MCP, Rclone configs, background jobs, KEY operations and init have owner isolation.

## Migration rule

Preserve the eight legacy Google/MEGA slots until the user explicitly reconnects/migrates.
A suggested old label is **not** a migrated connection. For each old slot, map its exact
remote/root/account to a new owner + connection ID, verify read/write boundaries and
readback, update NYX route mapping, and only then retire the old operator-wide route.
Do not silently give a legacy read-only slot write permissions.

## Implementation sequence

1. Finish database migrations, validations and two-user isolation tests.
2. Wire tenant-scoped registry to verified OAuth and MCP connection-management tools.
3. Implement provider OAuth/App installations, callback state protection and secure vault.
4. Add selectable resources + verify/reconnect/disconnect + MCP Apps UI.
5. Migrate existing Rclone operations with per-job temporary configs and owner-bound jobs.
6. Implement GitHub API operations, followed by an isolated Git CLI worker.
7. Verify CI, cross-user denial, provider-grant expiry, write approval, stable identities, cleanup and receipts. Deploy only after explicit approval.
