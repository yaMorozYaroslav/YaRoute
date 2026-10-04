# YaRoute Git migration

Status: migration in progress. Git is a verified mirror/implementation surface, not canonical Yaro authority yet.

## Current canonical source

- Head: `head_db_v025.zip` — Drive `1M0kL2VzWSLF2m32WkLE1zqSA-Kfmvhob` — SHA-256 `7391f63cbba78dcfb19901bd683675dc45a7af0fb1c8d2fe906956e88d3603c1`
- Body: `body_db_v022.zip` — Drive `17crbtFcY9TP594SWVpCLON1Les6snT6Y` — SHA-256 `91a77a92c1e457a250cfeebbdfc9ef6e6deef01c4b96ea99e944e868bf72e82e`
- Footer: `footer_db_v073.zip` — Drive `1LyFCCt-8G9zPhaJbJhpd0g34RZd6wvd7` — SHA-256 `8d3c068b55b351fa49a4824bde3d6917a58939b207ef7daf84e16a096ef6ef3b`

Private Git mirror/migration target: `linuxofpower/NyxGPT`.

## Runtime bootstrap

NestNyx resolves the current Drive authority in this order:

1. live `paths.md`
2. canonical Head / Body / Footer and exact hashes
3. Head `LEAD/Core_Skills/FileFilter/paths.json`
4. live `temp_paths.json`
5. Head `LEAD/Core_Skills/YaRoCLI/nyxcli.json`
6. live `temp_nyxcli.json`
7. staged/live `nyx_entry.md`
8. live `template_map.md` + `template_index.json`
9. project topology when it becomes canonical/available
10. Area/command-required sources

The historical `3_subfooter` route is normalized to the renamed `3_template` runtime folder while original provenance is preserved in receipts.

## Authority boundary

Git migration does not promote Git to canonical authority. That requires an explicit future Yaro architecture change through FIN → UPD → GEN → Footer/diff verification → CAN. Until then, Drive plus the newest canonical Footer remains authoritative.
