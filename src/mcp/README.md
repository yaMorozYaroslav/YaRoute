# NestNyx MCP boundary

The MCP layer exposes only logical shared-folder operations. It never accepts an rclone remote name or an absolute Drive path from a model.

V0 tools:

- `nyx_areas`
- `nyx_list`
- `nyx_stat`
- `nyx_capacity`
- `nyx_copy_file`
- `nyx_job_status`

`nyx_copy_file` is intentionally copy-only. It refuses clobbering, queues work, keeps the source, and relies on the existing worker to verify size, a common hash, and destination ownership.

The initial private connector uses `NYX_MCP_TOKEN` as a bearer secret. The secret may be supplied in an Authorization header for ordinary MCP clients, or as the final URL segment for hosts that cannot attach a static custom header. The secret URL is an MVP mechanism, not a replacement for OAuth in a shared or production deployment.
