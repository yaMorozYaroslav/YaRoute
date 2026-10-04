# YaRoute Git migration

**Canonical implementation repository:** `yaMorozYaroslav/YaRoute`.

Git is the public implementation and deployment surface for NestNyx. Canonical Yaro knowledge, continuity state, Drive object identifiers, private artifact hashes, account identities, credentials, and runtime storage configuration remain outside this public repository.

## Repository boundary

This repository may contain:

- reusable NestJS/TypeScript implementation;
- public-safe schemas and examples;
- deployment workflow definitions that reference secrets only through secret-variable names;
- public-safe documentation.

This repository must not contain:

- passwords, access tokens, API keys, OAuth client secrets, private keys, recovery codes, or reusable credential hashes;
- `rclone.conf`, encoded rclone configuration, or runtime environment files;
- personal email addresses or private account identifiers;
- private Google Drive IDs or private artifact hashes;
- alternate private GitHub mirror targets.

Runtime authority is resolved from configured external sources. Changes to canonical Head/Body/Footer continue to follow the Yaro lifecycle outside this repository.

## Deployment rule

All implementation changes and Heroku deployments for this service originate from:

```text
yaMorozYaroslav/YaRoute
```

Do not deploy another repository as a substitute for YaRoute.
