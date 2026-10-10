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
drive or folder root, MEGA to selected roots, and Heroku to already-existing apps.
Heroku account-level app creation is **permanently prohibited** due to financial risk.
Empty resource selection means **no resource access**.

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

The committed `HerokuReadonlyConnector` is now **broker-backed**, not a
Heroku bearer-token client. It exposes app info, releases and config variable **names**
only. A separate restricted read broker must supply results and MUST never send token
or config variable VALUES to NestNyx. There is no connected production broker yet.

The `HerokuOperationPlanner` supports read plans and future reviewed deploy/restart
plans for already-existing approved apps. Plans are **not executable approvals**.

**Permanently prohibited:** payments, billing reads/writes, cards, invoices,
subscriptions, upgrades/downgrades of tariffs or pricing, dyno scaling/formation,
add-ons, purchases, marketplace buys, new paid resources, and automatic Heroku app
creation. The old `heroku:apps:create` capability remains in the metadata type only
to recognize legacy records; it is unavailable in selection and fail-closed at runtime.
General `heroku:config:write` is also forbidden because it can activate billable
integrations; a future narrow per-key secure operator may exist but must never
support spend-affecting changes. This restriction is **not overrideable** by owner,
automation, plugin settings, ChatGPT prompt, or a wider OAuth grant.

The backend MUST NOT hold a broadly privileged Heroku API token with billing access.
Only an independently isolated credential broker, with payment/billing routes denied
and minimum provider permissions, may hold a token. If the provider cannot issue or
broker a genuinely non-financial credential, leave that integration disconnected.
Never connect billing accounts or credit cards to the NYX plugin.

Heroku deployments and Git pushes can still indirectly create metered usage even
without billing API access. Therefore require human review, approved release SHA,
provider-side spend controls where available, rate/cost ceilings and restricted CI
permissions. There is no truthful guarantee of zero indirect spend merely from
blocking billing endpoints.
Use GitHub Actions deployment workflow to deploy a reviewed SHA (already in repository,
currently manual dispatch only), or an independently verified deployment worker.
Log release IDs and health-check receipts, support rollback. Do not deploy automatically.

## Immutable financial access boundary

This is a standing, project-wide restriction for **all future connectors**, not just
Heroku. NYX must never read payment details or initiate any immediate or recurring
charge, change tariffs, pricing tiers, subscriptions or payment settings, buy add-ons,
scale billable infrastructure, or provision paid resources.

The `financial-safety.ts` policy rejects known finance operations even if a legacy
record says permission is enabled and granted externally. The UI capability list
excludes them and both connection and resource authorization fail closed.

Security is multi-layered: (1) typed operation allowlists, (2) registry denial,
(3) independent broker-side denial, (4) no broad payment-capable credentials,
(5) no arbitrary shell for Git/Heroku/Drive, and (6) provider-side billing/spend
controls outside NYX. Never claim protection for a new provider without verifying
the whole path. Billing settings must be managed manually outside NestNyx.

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
