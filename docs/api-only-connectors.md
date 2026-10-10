# NestNyx API-only connectors — owner decision, 2026-10-10

**Decision:** Do not give NYX Git CLI or Heroku CLI access. Use narrowly scoped
provider API connectors instead. This supersedes earlier CLI-worker proposals
in docs/production-connectors-cli.md, which is retained for historical context.

## Allowed direction
- GitHub/GitLab: typed APIs for repository and file reads, commits, branches,
  PRs, issues and CI metadata. Each specific mutation requires separate
  resource authorization, impact checks and approval when appropriate.
- Heroku: individually permitted Platform API operations for already-selected
  apps, through a restricted broker. Start with safe metadata.
- Google Drive / MEGA: user-selected accounts, folders and permissions through
  provider APIs. Preserve existing Rclone-backed storage as a private legacy
  implementation until migrated; do not expose arbitrary Rclone commands.
- NYX's canonical Yaro command language remains supported as before; it is
  not operating-system shell access.

## Non-negotiable limits
- No Git or Heroku CLI interface, no general-purpose shell operation.
- No generic provider API passthrough with user-supplied URL/method.
- No direct payment/billing/tariff/subscription control, provisioning paid
  resources, scale/plan changes or ability to alter financial safeguards.
- Provider credentials must be restricted independently of instructions and UI.
- Existing write/deploy possibilities may still trigger usage-based charges:
  preflight risk warnings and independent authorization remain mandatory.
- Legacy Git CLI capability labels must not be offered or accepted.
- Existing names (google_main, google_work, mega_main, etc.) are optional,
  editable connection-name suggestions, not mandatory permission presets.

## Implementation status
The Git CLI planner has been disabled and the connector registry rejects
legacy git:* grants. Current GitHub API read functionality is partial;
OAuth onboarding, persistent account linking, writable provider APIs, Heroku
broker connectivity, risk-enforcing job dispatch and the ChatGPT UI are not
fully operational. This is repo architecture work, not a completed deployment.

Canonical Head governance remains authoritative. This accepted decision is
pending a separate canonical Head/Footer generation transaction.
