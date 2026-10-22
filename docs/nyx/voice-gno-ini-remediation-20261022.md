# NYX Voice Global Normal INI — remediation checkpoint (2026-10-22)

Status: PROPOSED PATCH / NOT DEPLOYED. This file is review evidence, not a Head bundle, a promoted key, or a successful session FIF.

Verified authority: H31 SHA e857f66037cdae2ee998f714770ce94ee77caebeddcb0bf1ea13fc944a191007; B27 SHA 10a9de90eae422f049a34b4bad4577ae09851c3de69bcdf44690633636acc791; latest F99 is compare checkpoint with canonical promoted F97. F99's recorded next action is a Body-only FIN/UPD/GEN migration. Preserve that priority until explicitly reconciled.

Failures observed:
1. NestNyx Head cache reported H28/B24/F80 while verified Footer v099 points to H31/B27/F97. Runtime deployment/bootstrap locator is stale.
2. nyx_ini/nyx_execute invocations were blocked by host safety checks; no backend exception or FIF receipt was observed.
3. H31 LEAD/Canonical_Authority_Resolution_v002.json current.initbun points to v004 although H31 includes InitBun v006. Head correction should add authority v003, preserve v002 and update nyx_entry.md in separately gated next Head generation.
4. config/nyx-runtime-profile.json Normal sources include NoteFlow-specific todo_30/todo_90/togive but omit Voice-specific todo_30. The current Head and active pending keys require Voice Normal todo_30. This runtime profile is a protected configuration file; connector refused writes (GITHUB_INFRASTRUCTURE_WRITE_FORBIDDEN). Do not bypass this boundary.
5. The connector fallback prepared files but did not create a verified FIF and did not visibly render every mandatory source.
6. Voice is typed-resource ambiguous (Area and Core Skill) under H31. Require a verified typed resolution.
7. Stale dated planning must be reconciled with current todo.md, never silently closed.

PROPOSED config/nyx-runtime-profile.json change: in commands.ini.sources.normal after todo_10, before toget, add:
{
  "key": "todo_30",
  "required": true,
  "visible": true,
  "when": "targeted",
  "perTarget": false,
  "forTarget": "Voice",
  "ref": { "area": "MAIN", "path": "Documents/Notepad/0_active/todo_30.md" }
}

Keep existing NoteFlow-only sources untouched. Before any protected config update, repin the runtime bootstrap locator and profile cliSha256 to the *verified* H31 CLI member hash, and test command contracts. Do not change profile SHA while the old H28 locator is still deployed.

Acceptance tests:
- Reject stale H28 CLI cache when canonical H31 is current.
- Typed Area:Voice oGN resolves exact manifest/config/Area owner and requires full paths.md/maps.md/todo.md/todo_10.md/todo_30.md/toget.md receipts in source order.
- Verify mandatory visible output in client, not just files_to_paste returned by backend.
- Missing read/render => NOT_READY; no fabricated COMPLETE.
- New FIF readback verifies idempotent persistent handoff; first SUM reuses identity.
- Invalid/ambiguous typed target fails closed.
- Current Todo status is not overwritten by stale horizon entries.

Deployment must be reviewed separately; no merge, deploy, Head GEN/CAN or data mutation is authorized by this checkpoint.
