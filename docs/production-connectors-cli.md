# NestNyx production connectors and CLI execution contract

Status: engineering plan + early type-safe library contracts. Nothing below asserts that OAuth
onboarding, CLI execution, Heroku administration or the ChatGPT settings UI is live.

## Preserve all already-used capabilities

Existing production/private code remains separate until migrated and verified:
- `nyx_execute`, `nyx_ini`, `nyx_sum`, canonical Head/CLI bootstrap, FIF/FIB handoffs.
- `nyx_mega_accounts`, `nyx_mega_list`, `nyx_mega_stat`, `nyx_mega_capacity`.
- Storage areas, capacity, file list/stat, file copy with destination verification,
  and `nyx_global_index`. Existing MEGA copy remains explicitly disabled.
- Rclone-backed Google Drive and MEGA roots, metadata/hash/owner verification,
  private routing and `NYX_SHARED_ROOTS_JSON`.
- Existing API-key HTTP routes and OAuth-protected MCP routes; do not remove auth.
- PostgreSQL job records, tenant handoffs and canonical routing.

New provider-neutral connections must **not** quietly replace the old source identifiers.
Migrate using explicit verified owner mappings; retain old names as optional editable
placeholders: google_main, google_work, google_a/b/c/d, mega_main, mega_work.

## Dynamic connection configuration

Every connection has immutable `id`, owner, provider, user-selected `displayName`,
external identity, status, requested capabilities, independently verified provider grants,
and one or more typed resource rules. A user may add many connections of one provider,
change a label, and choose effective permissions without gaining extra provider scopes.

Resource rules can restrict Git to selected repositories and branches, Drive to a selected
drive or folder root, MEGA to selected roots, and Heroku to selected apps or an account
for explicit app creation. Empty resource selection means **no resource access**.

All new functionality MUST check the intersection:
verified authenticated owner + user enabled capability + provider grant +
resource/branch/path rule + operation approval (where needed).
Provider grants must never be accepted from a ChatGPT tool input or UI.

## Git CLI backend

Node/NestJS can launch the Git binary using `child_process.spawn`; this is NOT the same
as making a safe public Git shell. The typed `GitOperationPlanner` currently supports
plans for status, log, show, diff, clone, fetch, branch, commit, push and tag.
It does not execute them or advertise them as available MCP actions.

Production Git CLI execution requires a dedicated isolated worker with:
- fixed command allowlist and typed argv (NEVER arbitrary command strings or `shell:true`);
- per-user/per-repository temporary working directories, no traversal, quotas/timeouts;
- short-lived GitHub App installation tokens restricted to granted repos and capabilities;
- credential helper/askpass or equivalent secret-safe transport, NEVER tokens in argv,
  origin URLs, stdout, logs, git remotes, commit messages or Head/Body;
- tracked diffs and immutable commit receipts; explicit approval for writes,
  force pushes, branch deletion, history rewrite, and protected branch operations;
- bounded outputs and job result polling, cancellation, redacted logs and auditing;
- independent server-side verification that the operation matches the canonical NYX
  command authority, rather than interpreting free-form shell text.

Add richer Git actions (PRs, issues, releases, merge/rebase, workflow dispatch)
as individually authorized typed commands after the foundation is verified.
Prefer provider APIs for routine reads and simple writes; invoke Git CLI only
when necessary (diff, rebase, merge, worktree operations etc.).

## Heroku management

Heroku supports a Platform API and CLI. Use the API for connection management;
keep CLI/deployment jobs in a separate control plane so self-redeploy does not
terminate the HTTP request holding authorization state.

The committed `HerokuReadonlyConnector` supports app info, releases and config
variable **names** only. The `HerokuOperationPlanner` names future operations:
app info, releases, logs, config names, config set, app deploy/restart/create.
Planning objects are never executable approvals.

Production authorization must include separate Heroku user OAuth or scoped admin
credentials, allowed apps, a secure secret vault, expiry and revocation.
A connected Heroku account must not automatically imply app creation,
billing changes, secret-value reads, or production deployment rights.

Heroku admin writes require explicit approvals with non-replayable action receipts.
`config.set` takes secret references entered via a secure UI or vault, never credential
values in LLM-visible MCP arguments. Never return config values to ChatGPT.
Use GitHub Actions deployment workflow to deploy a reviewed SHA (already in repository,
currently manual dispatch only), or an independently verified deployment worker.
Log release IDs and health-check receipts, support rollback. Do not deploy automatically.

## Release gates

1. Confirm current CI and security audit runs on the intended exact commit.
2. Configure DB, schema migrations and encrypted token storage with backups.
3. Complete provider authorization callbacks, refresh/installation grants, CSRF state,
   disconnect/revoke; test at least two users and two accounts per provider.
4. Wire connection registry to OAuth-scoped NestJS services/MCP tools and ChatGPT
   plugin settings UI. Keep storage public-mode refusal until isolation is proven.
5. Implement and test resource-scoped Git worker and Heroku admin coordinator in
   a staging environment. Verify approvals, limits, secret redaction, crash recovery.
6. Run production smoke checks, rollback drills, monitor latency and rate limits,
   add clear privacy/terms/support content before public directory submission.

A custom ChatGPT MCP plugin can be tested with an HTTPS Heroku app URL; a paid
custom domain is not a prerequisite for initial private testing. Public directory
submission has separate verification, review and policy requirements.
