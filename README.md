# NestNyx

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/linuxofpower/NestNyx)

NestNyx is the execution side of Nyx storage operations. ChatGPT can inspect explicitly shared Google Drive folders and, through the MCP endpoint, call a small allow-listed set of storage tools. NestNyx executes those tools with `rclone` against the same logical shared-folder roots.

The boundary is deliberate: **neither REST nor MCP accepts arbitrary rclone remote names or unrestricted Drive roots**. Every path is resolved below a configured shared folder.

## V0.3 capabilities

- NestJS HTTP API suitable for Heroku.
- Remote MCP endpoint using the official Model Context Protocol TypeScript SDK.
- OAuth-protected `/mcp` resource-server boundary for ChatGPT Business/Enterprise/Edu custom apps.
- RFC 9728-style protected-resource discovery at `/.well-known/oauth-protected-resource`.
- JWT access-token validation against an external OAuth/OIDC issuer and JWKS.
- Installs the official rclone binary during the Node build.
- Keeps `rclone.conf` out of Git; provide it as a Heroku config var.
- Maps logical storage aliases such as `MAIN`, `A`, `B`, `C`, `D` to rclone roots at runtime. `MAIN` is the canonical Nyx bootstrap source; other configured aliases remain available to storage tools.
- Lists/stats only below configured roots.
- Reports account capacity for remotes backing configured roots.
- Queues cross-account file copies.
- Refuses destination clobbering with rclone `--immutable`.
- Verifies copied size, a common hash, and destination owner.
- Does **not** delete source files.
- Uses Postgres for durable jobs when `DATABASE_URL` is present.

## Architecture

```text
ChatGPT / Nyx
    |
    | Google Drive connector: inspect shared folders
    | NestNyx MCP: request approved actions
    v
OAuth-protected /mcp on Heroku
    |
    v
NestNyx storage services
    |
    v
rclone
    |
    +--> Google Drive A
    +--> Google Drive B
    +--> Google Drive C
    +--> Google Drive D
```

Shared folders are the GPT-visible control surface. Private rclone remotes are the execution/data plane.

## MCP tools

- `nyx_ini` — resolve and verify the canonical Nyx bootstrap from the configured `MAIN` drive, with optional Area hydration.
- `nyx_areas` — list configured logical storage aliases.
- `nyx_list` — list files/folders below one shared root.
- `nyx_stat` — inspect metadata, hashes, size, and owner.
- `nyx_capacity` — report account quota information.
- `nyx_copy_file` — queue a verified cross-area copy; source retained.
- `nyx_job_status` — read job state and verification evidence.

## Heroku config vars

### Storage

`RCLONE_CONFIG_B64`
: Base64 of the existing `rclone.conf`. Never commit it.

`NYX_SHARED_ROOTS_JSON`
: Logical shared-area mapping. Example only:

```json
{
  "MAIN": { "remote": "linuxofpower", "root": "." },
  "A": { "remote": "drive_a", "root": "A_Shared", "expectedOwner": "account-a@example.com" },
  "B": { "remote": "drive_b", "root": "B_Shared", "expectedOwner": "account-b@example.com" },
  "C": { "remote": "drive_c", "root": "C_Shared", "expectedOwner": "account-c@example.com" },
  "D": { "remote": "drive_d", "root": "D_Shared", "expectedOwner": "account-d@example.com" }
}
```

`MAIN` should point at the root of the `linuxofpower` Google Drive account. The canonical initialization defaults are:

```text
NYX_INIT_AREA=MAIN
NYX_PATHS_REGISTRY_PATH=ChatGPT/1_body/1_areas_v0/NoteFlow/3_resources/SYSTEM/paths.md
NYX_AREAS_ROOT_PATH=ChatGPT/1_body/1_areas_v0
NYX_YARO_PREFIX=YaRoute
```

Only `MAIN` is required for `nyx_ini`. Additional aliases are optional and become immediately usable through `nyx_areas`, `nyx_list`, `nyx_stat`, `nyx_capacity`, and copy jobs when present in `NYX_SHARED_ROOTS_JSON`.

`NYX_API_KEY`
: Optional separate secret used by the protected REST storage API.

### MCP OAuth

`NYX_PUBLIC_URL`
: Public HTTPS origin, e.g. `https://your-app.herokuapp.com`.

`NYX_OAUTH_ISSUER`
: External OAuth/OIDC issuer URL.

`NYX_OAUTH_AUDIENCE`
: Audience/resource identifier required in access tokens.

`NYX_OAUTH_JWKS_URI`
: Optional JWKS override. If omitted, NestNyx reads `${NYX_OAUTH_ISSUER}/.well-known/jwks.json`.

`NYX_OAUTH_SCOPES`
: Comma-separated scopes required by the MCP endpoint; defaults to `nyx.read,nyx.write`.

The production MCP endpoint is simply:

```text
https://YOUR-APP.herokuapp.com/mcp
```

Do not put secrets in the URL. ChatGPT authenticates with OAuth and sends `Authorization: Bearer <access_token>`.

## Prepare rclone config

On the machine that already has the tested rclone remotes:

```bash
base64 -w0 ~/.config/rclone/rclone.conf > /tmp/rclone-config.b64
```

Paste that value only into Heroku `RCLONE_CONFIG_B64`.

## Business-compatible OAuth setup

NestNyx is an OAuth **resource server**. Use a real OAuth/OIDC provider (for example Auth0, Okta, Entra ID, or another standards-compliant provider) as the authorization server.

Configure that provider so access tokens:

- are JWTs signed by a published JWKS;
- use the exact issuer configured in `NYX_OAUTH_ISSUER`;
- contain the audience configured in `NYX_OAUTH_AUDIENCE`;
- grant `nyx.read` and `nyx.write` scopes;
- can issue refresh tokens (`offline_access`) so ChatGPT can remain connected.

When creating the custom app in ChatGPT, use OAuth authentication, copy the exact ChatGPT callback URL into the provider's allowed callback/redirect URLs, then enter the provider client ID and client secret in ChatGPT and run **Scan Tools**.

## OAuth discovery smoke test

After deployment:

```bash
curl https://YOUR-APP.herokuapp.com/.well-known/oauth-protected-resource
```

It should return JSON containing the MCP resource URL, authorization-server issuer, and supported scopes.

Calling `/mcp` without a bearer token should return `401` with a `WWW-Authenticate` header pointing at the protected-resource metadata.

## REST smoke tests

Health is public:

```bash
curl https://YOUR-APP.herokuapp.com/health
```

Protected REST endpoints use `X-Nyx-Key`:

```bash
curl -H "X-Nyx-Key: $NYX_API_KEY" https://YOUR-APP.herokuapp.com/storage/areas
curl -H "X-Nyx-Key: $NYX_API_KEY" https://YOUR-APP.herokuapp.com/storage/capacity
curl -H "X-Nyx-Key: $NYX_API_KEY" https://YOUR-APP.herokuapp.com/storage/B/list
```

## Safe copy lifecycle

```text
PLAN
  -> VALIDATE SHARED ROOTS
  -> QUEUE COPY
  -> RCLONE COPY (NO CLOBBER)
  -> READBACK
  -> HASH/SIZE CHECK
  -> DESTINATION OWNER CHECK
  -> PERSIST EVIDENCE
```

There is deliberately no source-delete or move endpoint yet. We first prove end-to-end ChatGPT -> OAuth -> MCP -> NestNyx -> rclone copying and verification before adding cleanup.
