# Nyx command runtime

The interpreter reads a private stable bootstrap locator, checks CLI authority on every request, validates the registry, matches one command and dispatches its typed execution contract. It does not translate prose command definitions into executable semantics. OAuth and existing storage tools remain in place. `nyx_ini` and `POST /init` forward to the interpreter. The former heavyweight init is retained separately at API-key-protected `POST /init/check`; it is no longer an init fallback.

## Current activation boundary

The inspected canonical Head v028 CLI v004 has descriptive `ini` semantics but no typed `execution` contract. The live deployment therefore uses a private, user-authorized execution profile pinned to the exact canonical CLI content SHA. The profile can bind adapters only to existing CLI commands. Names and aliases remain canonical. A CLI change invalidates the profile until it is reviewed and rebound; invalid profile data stops execution. Head, Body and Footer are not rewritten.

This operational configuration enables Basic init and verified current working routes. It does not canonicalize chat decisions into core authority. Normal/Deep, unresolved Area targets and full SUM remain unavailable until their contracts/routes are configured. Core changes follow the separate Yaro generation lifecycle.

## Private bootstrap

`NYX_BOOTSTRAP_PATH` is a relative path within `NYX_INIT_AREA` (default logical area `MAIN`). The locator is a small private file with schema `nyx.bootstrap.v1`:

```json
{
  "schema": "nyx.bootstrap.v1",
  "cli": { "area": "MAIN", "path": "authority/nyxcli.json" },
  "paths": {
    "basic": { "area": "MAIN", "path": "routing/paths.md" },
    "normal": { "area": "MAIN", "path": "routing/n_paths.json" },
    "deep": { "area": "MAIN", "path": "routing/d_paths.json" }
  },
  "canonical": {
    "head": "head_current.zip",
    "body": "body_current.zip",
    "footer": "footer_current.zip"
  }
}
```

These are synthetic examples, not actual routes or canonical pointers. A bundle-based CLI reference can supply `member` and mandatory `sha256`; only that exact ZIP member is read on a cold cache. Ordinary standalone CLI avoids unpacking. Application startup warms only this CLI cache to keep ZIP extraction outside the first request. Invalid warmup leaves commands fail-closed on demand. The cache checks fresh provider hashes, identity and size on every command. Without a provider hash, it rereads bytes instead of trusting mtime/size. Changed invalid authority clears the cache and halts execution.

## Execution schema

Existing CLI commands without `execution` are discoverable but not executable unless a verified private profile supplies their contract. The bootstrap may reference `executionProfile` using the same area/path resource shape. Its schema is `nyx.runtime-profile.v1`, authority is `user-authorized-runtime-configuration`, `cliSha256` pins the CLI content, and `commands` maps existing command names to execution contracts. Profile hashes are recorded in FIF and response metadata. The profile is reread on each command. The implementation supports two typed adapters: `context.initialize.v1` and `context.read.v1`. It does not bind particular command names to adapters. Other adapter contracts require an implementation before execution.

Each matched command supplies:

- `aliases`: optional command aliases; collisions reject the registry.
- `execution.adapter`: implemented capability identifier.
- `execution.arguments`: `{ "targets": true, "maxTargets": 16 }`.
- `execution.depth`: `{ "default": "basic", "allowed": ["basic", "normal", "deep"] }`.
- `execution.sources`: explicit `basic`, `normal`, `deep` arrays in desired response order.
- Each source: `key`, `required`, `visible`, optional `when: "targeted"`, optional `perTarget: true` with `{target}` in its route key.
- `pathsVisible`: whether to include the selected Paths document in `files_to_paste`.
- `mutation`: `none` or `conversation-artifact`; init requires the latter.
- `handoffsKey`: resource key resolved through selected Paths.
- `verification`: `{ "sourceRead": true, "artifactReadback": true }` for init.
- `response`: `nyx.context.v1`.

A bare Basic init contract would select only maps plus visible selected Paths. A targeted contract would additionally select the planning sources and per-target state/config keys. The interpreter contains no hardcoded physical routes, planning filenames or Area names. In the structured API, `oGN` in `args` is a target name, not an inferred depth modifier. Compact text grammar is not implemented by this API; callers provide command, arguments and depth explicitly.

Basic is **Markdown only**. A human-readable route table supplies resource references:

```markdown
| key | area | path |
| --- | --- | --- |
| maps | MAIN | routing/maps.md |
| handoffs | MAIN | continuity/Handoffs |
| area:Example:state | MAIN | areas/Example/state.json |
```

Normal/Deep use a typed JSON document `{ "schema": "nyx.paths.v1", "resources": { "key": { "area": "MAIN", "path": "relative/path" } } }`. These are implementation schemas awaiting integration with authority-approved sources, not claims that existing routing documents already have this shape. There is no Basic `paths.json`. Legacy prose/snapshot routing is not silently promoted into executable routes.

## API and identities

`nyx_execute` / API-key-protected `POST /nyx/execute` accept:

```json
{ "command": "ini", "args": ["Voice", "oGN"], "depth": "basic", "conversationId": "caller-conversation-id" }
```

When no conversation ID is supplied, the server returns a new UUID as `conversation_id`; reuse it on every subsequent call. No automatic ChatGPT conversation identifier is available to this server. The compatibility `nyx_ini` tool accepts the UUID through its existing `sessionId` field and accepts multiple targets either as a space-separated `target` or a `targets` array. `scope` is retained for wire compatibility; this init projection is always conversation-scoped. Requests that change command scope require a future typed contract, not an inferred global write.

Artifact identity is derived from verified OAuth subject (or the API-key principal) and conversation ID. Raw subject, raw conversation ID and credentials are not persisted in FIF. OAuth and API-key identities are separate. Never use the same conversation ID for unrelated chats. `message_count` is `UNKNOWN` because the backend has no conversation-message telemetry.

Repeated identical init reuses the same verified checkpoint. Changed context appends an immutable revision with the same stable artifact ID. It never overwrites historical FIF evidence. PostgreSQL advisory transaction locks serialize the same identity across dynos. For this deployment without a database, explicit `NYX_HANDOFF_COORDINATION=single-dyno` supports exactly one `web.1` process with preboot disabled. Per-artifact serialization plus immutable, readback-verified Drive ledger checkpoints preserves lineage across restarts. New checkpoint records share a flat `runtime_lineage` folder to avoid per-session folder creation; the initially deployed nested ledgers remain readable without rewriting them. The deploy workflow checks formation and preboot before enabling this mode; other dyno names fail closed. Use PostgreSQL before scaling, enabling preboot, or running multiple Node processes. Single-dyno mode is not a distributed lock and topology changes outside the deployment workflow must respect this constraint. Initialization fails when neither supported coordination mode is configured. Readback verifies the exact bytes before saving the durable checkpoint or reporting success. An interrupted remote write can be recovered without rewriting its timestamp or evidence.

## FIF and FIB

The private FIF is `FIF_<id>.json` beneath the routed Handoffs root. It records command, canonical pointer labels, CLI hash/version, source references, content hashes, visibility receipts and continuity. It does not embed source contents or bundles. Later init revisions append under `FIF_<id>.revisions/`.

`FifPromotionPort.promote` supplies the SUM integration seam. It verifies the prior checkpoint, preserves the stable ID and source FIF, writes immutable FIB revisions containing `fif.json`, `summary.md`, `summary.json`, `sources.json`, `continuity.json`, and writes `manifest.json` last as the commit marker. Retries are idempotent; later summaries append to the same `FIB_<id>/revisions/` lineage. Re-init after promotion preserves FIB lifecycle. Full SUM rendering, log capture and command binding are not implemented or advertised as complete.

## Security and verification

Resource access stays within existing configured shared roots. Selected sources use at most four concurrent reads and retain command-defined response order. Every streamed read has a subprocess output limit; immutable writes use checksums and exact readback. Traversal, oversized resources, duplicate routes, unsafe mutation contracts, missing mandatory sources and credential-shaped source content fail closed. MCP errors redact provider stderr and private transport details. Temporary local transfer files are private and removed after use; generated conversation artifacts are never written into this repository.

Tests cover matching/aliases, invalid authority and cache reload, depth selection, targeted sources, immutable/idempotent FIF, identity isolation, interrupted-write recovery, readback tampering and FIB promotion. Tests also cover private profile authority binding and restart-safe remote ledger checkpoints. Production storage and PostgreSQL require live integration verification; in-memory resources are not evidence of a real Drive write.
