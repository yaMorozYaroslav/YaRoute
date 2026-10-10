> **Superseded decision (2026-10-10):** No Git CLI or Heroku CLI access for NYX. Use scoped provider APIs only. See [API-only connector architecture](api-only-connectors.md). Earlier CLI-worker proposals below are historical and MUST NOT be implemented.

# Multi-user connector framework (foundation)

The new connector model has **no fixed slots, default account names, or default per-user permissions**.

A user connects as many supported provider accounts as needed, chooses each connection's
`displayName`, and selects the capabilities to enable. Connection IDs stay stable when
names change. Each connection is scoped to an authenticated owner. Names are unique per
owner (case-insensitive) at the PostgreSQL layer.

## Separate three levels of permission

1. **Provider authorization:** What Google/GitHub actually granted, verified by the provider.
   Stored as `providerCapabilities` metadata. Only trusted authorization/refresh code may
   update it (a user-facing API must NEVER accept this field).
2. **User-enabled permissions:** The subset the user wants NestNyx to perform, stored as
   `capabilities`. Users can choose read-only or enable other supported actions. If they
   select a capability that has not been granted externally, it is saved as a request but
   cannot run; `setPermissions` reports `authorizationRequired`.
3. **Action-specific authorization:** The backend must still verify user identity, resource
   access, provider API permissions, and approvals for writes/destructive actions.

A permission selection in NestNyx **cannot grant Google scopes or GitHub App permissions**.
Broader access requires the provider's consent/installation flow. Never imply that a
requested capability is active before verification.

## User-visible experience (planned)

- Add connection: select provider, authenticate with OAuth/App installation, choose a name,
  choose available permissions.
- Manage: list, rename, enable/disable individual capabilities, verify, reconnect, disconnect.
- Multiple connections may use the same provider and the same external account; identities
  remain distinct and separately authorized.
- All UI/MCP actions derive `ownerId` from verified NestNyx authentication, never user input.
- Display names are labels only; use stable connection IDs for credentials and audit trails.

There will be **no fixed `google_main`, `google_a`, etc. in the new connection manager**.
Existing `PUBLIC_STORAGE_SCHEMA` slots remain temporarily as **legacy compatibility**.
We will migrate their contents via verified user-owned mappings before retiring that code;
do not delete existing Rclone remotes or rewrite current storage routes prematurely.

## Code already committed

- `ConnectorRegistry`: per-owner access, rename, permission selection, checking both
  user-enabled capability and independently verified provider permission.
- `PostgresConnectorRepository`: per-owner connection metadata, user-defined display names,
  case-insensitive unique names, additive migration for early connector records.
  Existing records gain a temporary name derived from their stable ID and empty provider
  grants (fail-closed), requiring re-verification.
- `GithubReadonlyConnector`: read-only Actions workflows, runs, and job metadata.

## Not yet implemented or deployed

These are library building blocks, not a connected multi-user interface. The database
repository is not yet wired to NestJS; there are no connector routes, MCP tools, UI,
OAuth callbacks, connection creation endpoints, credential vault, or GitHub App token
issuer. New tests are committed but CI success has not yet been verified.

Production prerequisites:

1. Integrate authenticated user identity and persistent repository in NestJS.
2. Implement authorized Google OAuth/GitHub App onboarding, callback state/CSRF checks,
   refresh/installation tokens, encrypted storage and revocation.
3. Derive provider grants from independently verified authorization responses; enforce
   and periodically refresh grants and selected repository/resource access.
4. Enforce per-user ownership on all operations, handle duplicate-name violations and
   concurrent updates, rate limits, pagination, auditing, bounded API responses and errors.
5. Verify read-only flows, then use explicit opt-in and approvals for write/delete/dispatch.
6. Migrate legacy slot-based storage with readback verification before removing anything.

Google Drive and Git share connector ownership and permission concepts but retain
provider-specific resource semantics. Canonical Head remains authoritative for Yaro
command behavior; this code is not a canonical core-bundle generation.


## Never expose financial control

This is an **immutable safety constraint across all connectors and CLI workers**,
even for an account owner: NYX may not access payment methods or financial account
details, purchase paid services/add-ons, create potentially billable Heroku apps,
change plans or tariffs, alter resource sizes/formation/scaling, or enable recurrent
charges. Additional provider permissions or ChatGPT approvals cannot override it.
There is no billing read API in NYX.

- `SELECTABLE_CONNECTOR_CAPABILITIES` removes permanently forbidden capabilities.
- `ConnectorRegistry.require()` rejects them, including historic database grants.
- `HerokuOperationPlanner` rejects app creation, arbitrary config writes and billing.
- Heroku metadata now requires a separate, finance-blind credential broker; NYX
  must not hold broad Heroku tokens with access to billing endpoints.
- Provider-specific Git/Heroku workers must use typed allowlisted operations and
  no arbitrary shell, process credentials, or unrestricted provider API paths.

**Financial safety is separate from ordinary user-adjustable permissions.**
A user may name a connection and select ordinary access levels, but cannot activate
prohibited payment or tariff capabilities. Billing setup and payments must be
performed manually in the provider's own portal, outside NestNyx.

Deployment and Git actions can still indirectly incur metered compute/CI usage;
they require explicit review, external cost ceilings/budgets where available, and
independent restrictions on credentials. Do not claim an absolute no-spend guarantee
for broad deployment rights. Until those controls are verified, leave those
high-impact operations unavailable in the production MCP plugin.

These are library-level safeguards committed in YaRoute; they are not deployed
or canonicalized as a new Head bundle.
