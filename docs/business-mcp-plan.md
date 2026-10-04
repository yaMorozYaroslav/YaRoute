# Business MCP plan

NestNyx is designed as a remote MCP resource server for ChatGPT Business/Enterprise/Edu. The MCP endpoint is protected with OAuth bearer tokens issued by an external OAuth/OIDC provider; rclone and Google Drive credentials remain only in Heroku config vars.

## Required production environment

- `NYX_PUBLIC_URL` — public HTTPS origin of the Heroku app, e.g. `https://example.herokuapp.com`
- `NYX_OAUTH_ISSUER` — OAuth/OIDC issuer URL
- `NYX_OAUTH_AUDIENCE` — audience/resource identifier required in access tokens
- `NYX_OAUTH_JWKS_URI` — optional explicit JWKS URL; if omitted NestNyx uses `${NYX_OAUTH_ISSUER}/.well-known/jwks.json`
- `NYX_OAUTH_SCOPES` — optional comma-separated scopes, defaults to `nyx.read,nyx.write`

The MCP client discovers authorization at `/.well-known/oauth-protected-resource` and sends `Authorization: Bearer <access_token>` to `/mcp`.

The legacy static `NYX_MCP_TOKEN` endpoint is intentionally not part of the Business production path.
