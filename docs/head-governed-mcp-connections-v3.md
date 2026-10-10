# NestNyx Head-governed CLI and Connections Panel v3

## Canonical command boundary

- Current **running** bootstrap reported \`head_db_v028.zip\`, CLI \`v004\`, content SHA \`70e8cd6a1e4c52c2a21145ab02cdccb36ceab5f1fcb0f368d32acaa4e8b6c1c4\`. This reference is informational, not a new canonical pointer.
- The independently inspected Head v028 archive contains 21 \`LEAD/Core_Skills/YaRoCLI/nyxcli.json\` command definitions. Each has a nonempty \`purpose\`.
- On every changed authority load, \`NyxCliRegistryService\` now rejects the **whole** CLI if any defined command has no meaningful \`purpose\` (minimum eight trimmed characters). A runtime execution profile cannot supply or override this Head description.
- Existing resolution then demands a typed execution contract. Undescribed or unsupported commands are not dispatchable through \`nyx_execute\`; \`nyx_ini\` and \`nyx_sum\` remain wrappers over the same canonical resolver. No new Yaro command has been added.
- Do not infer current authority from the largest-numbered ZIP on Drive; resolve the canonical bootstrap and verify its hash.

## Important distinction: transport and infrastructure endpoints

The above is a strict **Yaro CLI** gate. It does **not** mean that all NestJS HTTP routes or MCP auxiliary tools appear in the Head command table. Required \`/health\`, \`/mcp\`, OAuth metadata/callback, internal storage endpoints, and MCP Apps connection tools are infrastructure and still have separately documented interfaces. Do not present them as Yaro CLI commands or invent Head semantics.

Enforcing *literal Head allowlisting of every HTTP/MCP endpoint* would need a separately generated and promoted, machine-readable Head endpoint registry and an explicit treatment of required transport and auth endpoints. This change does not silently rewrite canonical Head or shut down working transport.

## Connections Panel v3

MCP Apps resource: \`ui://nestnyx/connections/v3.html\`. Entrypoint: \`nyx_connections_panel\`.

- **GitHub:** Existing owner-scoped GitHub App authorization, per-repository permissions, review-branch code writes, draft PRs and issues. No default-branch writes, merge, workflow dispatch, secrets or billing APIs.
- **Rclone:** Existing private Google Drive/MEGA remote inventory, plus a per-remote **Test access** action. The MCP Apps-only \`nyx_rclone_connection_test\` tool calls bounded \`rclone about remote:\`, discards all provider output and returns only \`reachable\` or \`unverified\` with a safe error code. \`unverified\` can also mean that the backend does not support \`about\`.
- The Rclone probe is **private-only** and requires a bound OAuth owner. Inputs must be an existing typed configured remote; public multi-user mode rejects it. No filesystem listings, password fields, token exposure, config edits, provider link/unlink or remote deletion.
- Provider remote creation, reauthorization and true credential revocation are **not implemented**. The private process-wide \`RCLONE_CONFIG_B64\` bootstrap is unsuitable for ad hoc UI mutation or per-user credential control. That requires a separate secure, persistent credentials lifecycle with owner approval and verification before release. Never write live credentials into PRs or ChatGPT.

## Activation / verification

1. Review and merge the code via an approved PR; do not silently deploy.
2. Manually dispatch the existing owner-managed \`deploy-heroku.yml\` workflow.
3. Verify \`/health.commit\` matches the intended deployed commit.
4. Refresh the NestNyx MCP connection and open the **v3** panel.
5. Confirm authenticated GitHub operations and Rclone inventory; test a non-critical Rclone remote. Confirm public mode rejects the private tool and that no secrets appear in responses.
6. Treat missing app rendering, grants, backend deployment or OAuth as \`UNVERIFIED\`, not success.
