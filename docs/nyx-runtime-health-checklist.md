# NYX runtime verification checklist — phase 1

Status: **Dev review candidate**. This document and the private `GET /nyx/checklist` handler do not deploy, generate Head/Body/Footer, approve a release, or execute Nyx mutations.

## Why /health is insufficient

The public `GET /health` response proves process liveness, selected service identity, commit label, Rclone version, and job-store durability. The read-only GitHub workflow additionally probes `/health` and compares its reported commit with the `tester` branch. Neither operation proves that all CLI commands execute, that the latest canonical Head/Body/Footer are loaded, or that mutable Template queues were reconciled.

## Checklist evidence contract

Every row must have `PASS`, `WARN`, `FAIL`, or `UNVERIFIED`; a redacted evidence description; and optional non-secret metadata. Never convert `UNVERIFIED` to `PASS` on the basis of missing data, successful imports, a mock, a version label, or a stale previous check. `READY` is possible only when every required row has independent verified receipts; phase 1 intentionally reports `NEEDS_REVIEW` while external gates are missing. `FAIL` always produces `BLOCKED`.

| ID | Meaning | Current phase-1 evidence | Next receipt needed |
| --- | --- | --- | --- |
| `deployment.commit` | Reported runtime SHA | Local deployed commit label only | Exact GitHub Tester SHA + live `/health` match |
| `canonical.registry` | Current authoritative CLI loaded | Fresh bootstrap locator + schema-validated CLI and SHA256 | Verified current Head member/hash |
| `canonical.bundles` | Latest valid Head, Body and Footer | **UNVERIFIED**; locator names are display-only | Canonical Drive file IDs; archive SHA256; manifest hashes, versions and Footer continuity; exact content-match attestation |
| `cli.contracts` | Defined commands vs backend adapters | Exact canonical list and typed execution bindings | Contract-by-command test matrix |
| `runtime.profile` | Operational profile pinned to canonical CLI | CLI fingerprint inspection | Recheck running revision and approved profile source |
| `template.pins` | `active_key`, `temp_paths`, `temp_nyxcli` | Enforced vs observed pin hashes; no content exposed | Resolve drift through Head/Footer lifecycle; observations are warnings, not silent updates |
| `template.queue` | Temp files/keys and pending seeds | **UNVERIFIED** | Current Template queue inventory, Footer pending/consumed seed ledger, and per-key provenance reconciliation |
| `cli.smoke` | Each Nyx CLI command actually works | **UNVERIFIED**, no commands invoked by health handler | Separate isolated test receipts per canonical command and alias at Basic/Normal/Deep and local/global; mutation commands only in disposable fixtures |
| `ci.functions` | Test coverage and outcomes | **UNVERIFIED** by runtime | GitHub Actions exact-SHA workflow, job IDs, test suite and assertions counts, failures/skips, age, artifact checksum |
| `security.tenants` | Protected access and multi-user correctness | **UNVERIFIED** by liveness | Real two-user read/write-denial, repo/source permissions, isolated roots, revocation, restart and rollback |

### Release gate rules

1. **Head / Body / Footer.** Resolve newest valid candidates in the configured Drive roots, verify archive members and manifests, use Footer as mutable continuity authority, and compare the deployed CLI/profile to verified Head. A newer unverified bundle is not canonical; don't silently replace older authority.
2. **Template.** Read paths through current canonical routing; compare hashes and keys only, never raw credentials. Warn for mutable `observe` drafts. Block for enforced key drift or schema conflict. Count pending, accepted, consumed and rejected proposals with provenance.
3. **CLI.** Enumerate from the loaded Head CLI, not a hardcoded list. Separate documented, typed-contract bound, resolver-test-covered, smoke-tested, and live-integrated counts. Execute mutations only in disposable fixtures with owner-isolated temporary credentials; production dry runs must not mutate.
4. **CI evidence.** Gather from GitHub Actions by exact Tester SHA; include `npm run build`, security check, `node --test` summary, warnings and flaky/skip counts. Test results are separate from live runtime success. For component and function coverage, map test names to functions via explicit tags/manifest—file counts alone do not prove coverage.
5. **Runtime and identity.** Test `/health`, exact deployed commit, configured storage capabilities without exposing paths/tokens, MCP OAuth, GitHub PR flow, and user isolation. Health should degrade to `UNVERIFIED` instead of querying private data from a public tenant session.
6. **Production gate.** Only a reviewed, CI-passing Tester candidate may open a *draft* PR to protected Master. The human code owner performs approval. No automatic Master merge, secrets disclosure, or premature Heroku cutover.

#
## Phase 2 — live tool for ChatGPT tool refresh

The authenticated MCP tool `nyx_runtime_checklist` (zero arguments) gives a bounded live process and public CI view. It reads `HEROKU_SLUG_COMMIT`/build-info, independently fetches the public `yaMorozYaroslav/YaRoute:tester` HEAD and GitHub check runs for **that exact running SHA**, and records whether the running app matches Tester. Only exact-SHA completed successful build and audit/security checks count toward `ci.workflow=PASS`. Pending, missing, stale and provider-error checks cannot count as success. The response includes no Github/Drive credentials and no mutation.

In the **public multi-user deployment**, the tool MUST NOT access the private operator bootstrap/Head, Rclone, Template source text, or private CLI. Canonical and Template checks remain `UNVERIFIED`, not fake failures or success. In the **private operator deployment**, the same tool may inspect the existing bounded CLI registry, approved execution profile and key-pin statuses using already-authorized private service dependencies. No mutating CLI is executed; the optional `hel` inspection is read-only. No user's profile may grant another user's access.

`ci.workflow=PASS` means the matching GitHub build/security checks succeeded. `ci.functions=UNVERIFIED` and `testCaseCounts.*=null` remain until a separate exact-SHA artifact has independently attested real test cases, skips and component mapping. Do **not** substitute passing job labels for per-function test coverage. If GitHub's unauthenticated public API is unavailable or rate-limited, report `UNVERIFIED` and leave any private state untouched.

After the reviewed Dev and Tester changes are merged **and the target app is actually deployed**, refresh NestNyxDev tools and call `nyx_runtime_checklist`. Verify its reported runtime SHA matches an independently fetched Tester commit. Tool discovery in ChatGPT is not by itself deployment evidence; a CI-passing PR branch is not a running Heroku dyno.

## Endpoints / access boundary

- `GET /health`: existing public, minimal liveness endpoint; unchanged.
- `GET /nyx/checklist`: **private legacy API route** guarded by `X-Nyx-Key`; fails closed in public OAuth tenant mode. It intentionally does not expose paths, credential material, source contents or GitHub token data. This first version does **not** make the checklist available through a public tenant or Nyx GPT plugin.
- Future: protected owner-scoped MCP `nyx_runtime_checklist` with an operator-only grant, and a public sanitized summary that contains **only** safe deployment/CI evidence. Do not mix owner-private canonical state into public tenant diagnostics.

### Execution cadence and noise

- On each Dev/Tester candidate: exact-SHA CI checklist and artifact retention (no email for individual pushes).
- Nightly or on-demand: low-impact, read-only canonical/Template drift check.
- Before Master PR: combined release gate with hard blockers and acknowledged warnings.
- Weekly, or only when requested: 3–5 lines covering material releases, failed gates and next action.

Phase-1 reports are diagnostic and cannot independently certify production readiness. Add GitHub Actions test-result attestation, authoritative Drive archive validation, Template inventory and isolated CLI matrix in later reviewed transactions; preserve this evidence distinction in all user-visible summaries.
