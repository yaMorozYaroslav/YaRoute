# NestNyx Heroku deployment

This branch contains a raw deployable NestNyx backend copied from the working NestNyx implementation.

## Where credentials go

Do **not** put credentials in GitHub files.

In Heroku, open the deployed app:

**Settings → Config Vars → Reveal Config Vars**

Add the required values there.

### Required for storage

- `RCLONE_CONFIG_B64` — base64-encoded rclone.conf
- `NYX_SHARED_ROOTS_JSON` — logical alias → rclone remote/root mapping
- `NYX_API_KEY` — random secret for protected REST routes

### Required for MCP/OAuth

- `NYX_PUBLIC_URL` — public Heroku HTTPS origin
- `NYX_OAUTH_ISSUER` — OAuth/OIDC issuer
- `NYX_OAUTH_AUDIENCE` — audience/resource identifier

### Optional

- `NYX_OAUTH_JWKS_URI`
- `NYX_OAUTH_SCOPES` — defaults to `nyx.read,nyx.write`
- `DATABASE_URL` — normally supplied by Heroku Postgres
- `NYX_OAUTH_ALGORITHMS` — defaults to `RS256`

### Initialization defaults

- `NYX_INIT_AREA=MAIN`
- `NYX_PATHS_REGISTRY_PATH=ChatGPT/1_body/1_areas_v0/NoteFlow/3_resources/SYSTEM/paths.md`
- `NYX_AREAS_ROOT_PATH=ChatGPT/1_body/1_areas_v0`
- `NYX_YARO_PREFIX=YaRoute`

## Health check

After deployment, open:

`https://YOUR-APP.herokuapp.com/health`

## Safety

Never commit `rclone.conf`, OAuth client secrets, access tokens, API keys, or Heroku credentials.
