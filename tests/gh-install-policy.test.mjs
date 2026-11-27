import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {preparePinnedGhAtBuild} from '../scripts/gh-install-policy.mjs';

test('public connector build prepares gh even with runtime CLI pilot disabled',()=>{
  assert.equal(preparePinnedGhAtBuild({
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_GITHUB_CLI_PILOT_ENABLED:'false',
  }),true);
  assert.equal(preparePinnedGhAtBuild({
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
  }),true);
});

test('private Pro and disabled/ambiguous connector builds skip gh download',()=>{
  for(const env of [
    {},
    {NYX_DEPLOYMENT_MODE:'private',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
      NYX_GITHUB_CLI_PILOT_ENABLED:'true'},
    {NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'false',
      NYX_GITHUB_CLI_PILOT_ENABLED:'true'},
    {NYX_DEPLOYMENT_MODE:'public'},
  ])assert.equal(preparePinnedGhAtBuild(env),false);
});

test('install script enforces the build policy and keeps a pinned archive SHA-256',()=>{
  const text=readFileSync('scripts/install-gh.mjs','utf8');
  assert.match(text,/preparePinnedGhAtBuild\(\)/);
  assert.doesNotMatch(text,/if\(process\.env\.NYX_GITHUB_CLI_PILOT_ENABLED/);
  assert.match(text,/gh_'\+version\+'_linux_/);
  assert.match(text,/GH_INSTALL_ARCHIVE_HASH_MISMATCH/);
});

test('MCP registration still requires explicit public pilot flag',()=>{
  const source=readFileSync('src/mcp/mcp.service.ts','utf8');
  assert.match(source,/process\.env\.NYX_GITHUB_CLI_PILOT_ENABLED==='true'/);
  assert.match(source,/server\.registerTool\('nyx_connection_github_cli_probe'/);
});
