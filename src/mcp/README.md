# NestNyx MCP boundary

The MCP layer exposes only logical shared-folder operations. It never accepts an rclone remote name or an absolute Drive path from a model.

V0 tools:

- `nyx_ini`
- `nyx_areas`
- `nyx_list`
- `nyx_stat`
- `nyx_capacity`
- `nyx_copy_file`
- `nyx_job_status`

`nyx_copy_file` is intentionally copy-only. It refuses clobbering, queues work, keeps the source, and relies on the worker to verify size, a common hash, and destination ownership.

Production MCP access uses OAuth bearer tokens validated by NestNyx against the configured issuer, audience, JWKS and scopes. Reusable tokens, client secrets, rclone credentials and other secret material must never be committed to this repository.
