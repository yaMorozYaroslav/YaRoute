# ChatGPT MCP OAuth reconnection — Dev hardening

Scope: `DevNestNyx` and `NestNyxPro` ChatGPT-facing MCP sessions, **not** Google
Drive/MEGA Rclone provider sessions. This source repository is Dev only; it
does not modify the production service or the OAuth issuer configuration.

## Authentication boundary

ChatGPT is the OAuth client. The external identity provider issues and refreshes
tokens. NestNyx is a resource server: it verifies the JWT issuer, audience,
signature, expiration and scopes. **NestNyx cannot refresh a ChatGPT-owned token
or extend its lifetime**, and it must never receive or persist a ChatGPT refresh
token through MCP tool arguments.

## Implemented fail-closed behavior

- Invalid, expired or missing bearer tokens still produce `401` with the
  OAuth `WWW-Authenticate` resource challenge.
- Unknown signing-key IDs remain `401`. They are not treated as a temporary
  outage, and the service never accepts an unverifiable token.
- Only recognized JWKS lookup transport failures, rate limits or provider 5xx
  responses produce `503 temporarily_unavailable` with `Retry-After: 15` and
  **no** `WWW-Authenticate` challenge. The same token may be tried again after
  the issuer recovers. This does not bypass signature checks.
- Private-owner allowlists and granted scopes remain enforced after recovery.

## Why a monthly prompt can survive the JWKS fix

The server-side change only prevents a **false** reconnect when the signing-key
provider is temporarily unreachable. It now also recognizes structured nested
Node/Undici socket, timeout, rate-limit and upstream 5xx errors. Unknown keys,
bad signatures, expired access tokens and revoked grants still fail closed.

ChatGPT normally **reuses the dynamically registered OAuth client** for the
same MCP connection. If the authorization server expires, rotates or deletes
that client or its secret, reconnecting can fail with `invalid_client`. Preserve
the DCR registration/client credentials for the lifetime of the connection.
If the refresh grant fails with `invalid_grant`, inspect the issuer's refresh-token
rotation, inactivity and absolute session limits. These changes are made in
the OAuth provider, not in NestNyx's bearer-token verifier.

Treat this as a three-part acceptance:
1. Confirm the exact deployed SHA on the intended Tester runtime without
   waking billable applications merely to collect telemetry.
2. In the issuer's admin UI verify that the ChatGPT DCR client persists and
   refresh tokens are supported, rotated correctly and not force-expired early.
   Never paste tokens or client secrets into a bug report.
3. Exercise a real ChatGPT automatic refresh **after access-token expiry**,
   including a temporary JWKS outage, and record only timestamps/error codes.
   A unit test or a successful MCP call with a still-valid token is not proof.

## Diagnose an approximately monthly reconnect

1. Record the affected plugin, the date/time, the ChatGPT error and whether
   both plugins expire together. Do not copy OAuth tokens into tickets or logs.
2. In the OAuth provider's administrative UI, inspect the **actual OAuth client**
   used by each plugin, its access-token lifetime, refresh-token availability,
   refresh-token rotation and absolute/idle session policy. Check whether the
   registered client persists across deployments. The active issuer is supplied
   privately by `NYX_OAUTH_ISSUER`; do not place its secrets in this repository.
3. Check the provider's OAuth discovery document for supported refresh grants,
   and test automatic token renewal before expiry. If the policy intentionally
   forces a new login monthly, keep that policy unless the owner reviews and
   changes it in the provider's admin UI.
4. Distinguish `invalid_client`, `invalid_grant`, expired JWT, bad audience,
   unknown `kid`, and transient JWKS/network failures. A temporary outage must
   not be classified as revocation. Never retry a known invalid grant forever.
5. Test the isolated Dev plugin through a real ChatGPT session and record a
   successful refresh over the provider's configured access-token lifetime.
   A green unit test does **not** prove monthly renewal.
6. Only after Dev tests and the correct provider configuration are verified,
   propose the reviewed change through the Tester/production release workflow.

Provider-side refresh/session policy is the likely remaining diagnosis for
monthly prompts; the code change in this repository handles the separate issue
of false reauthorization on temporary JWKS failures. No token duration has been
weakened, and no refresh or signing credentials have been copied into Dev.

References:

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/troubleshooting


## Native multi-account viewer — Dev implementation contract

- Two or more separately authenticated Google logins each produce a **signed,
  three-minute, display-only** `nyx_account_view_snapshot` under their own
  OAuth client connection; the model must not duplicate one owner's snapshot.
- `nyx_accounts_view` requires distinct signed owner references and the invoking
  OAuth identity must be one of them. The native MCP Apps UI uses one **Switch
  account** dropdown populated from the issuer-verified display emails.
- The selection persists only as non-authoritative widget presentation state.
  It never switches OAuth tokens or authorizes cross-account storage operations.
- Display all four grant names: `storage:list`, `storage:write`,
  `storage:move`, `storage:delete`. A granted write capability still requires
  a matching root grant, enabled write tool, and provider-side consent.
- Older cached `multi-v2.html` and `multi-v3.html` resource URLs remain
  resolvable for the same safe read-only UI.
- A combined view is **not** proof of refresh-token renewal. OAuth session
  renewal remains controlled by ChatGPT and Auth0 and needs an actual expiry
  crossing test. Do not relax JWT verification to reduce reconnects.

This code can be reviewed and tested in Dev without deploying to Pro or
changing user-owned storage, credentials, or permissions.
