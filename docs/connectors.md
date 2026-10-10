# Multi-user connectors (foundation)

ConnectorRegistry is a provider-neutral authorization boundary. Each connection is owned by a NestNyx user, and capabilities are checked before a provider adapter is invoked. The GitHub adapter currently supports **read-only Actions workflow, run and job metadata**.

This is a library foundation, **not a deployed, user-connectable integration**. No routes, MCP tools, database migrations, OAuth callbacks, GitHub App registration or secrets are enabled by this commit.

## Production requirements (not yet implemented)

1. Persist connection metadata in a tenant-scoped database with uniqueness and ownership constraints; never store tokens in Head/Body or ordinary records.
2. Complete GitHub App installation/OAuth authorization, CSRF/state validation and installation-to-user access checks.
3. Supply `GithubInstallationCredentials` through a secrets vault that issues short-lived installation tokens. Never accept client-provided bearer tokens.
4. Resolve `ownerId` exclusively from verified NestNyx auth; never from request arguments. Check access to installation and repository on every operation.
5. Add rate limits, pagination, audit events, token redaction, timeouts, and bounded API responses before exposing MCP tools.
6. Keep writes and CI dispatch disabled until explicit scopes and approval flows exist.

Drive and Git share connector identity and permission management, **not** identical file semantics. Canonical Head command contracts remain authoritative.
