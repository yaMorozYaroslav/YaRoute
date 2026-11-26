const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {publicGithubCliReadiness}=require('../dist/connectors/github-cli-safe');

test('public CLI readiness never claims verified execution from file presence',()=>{
  const seen=new Set(['/usr/bin/git',path.resolve('.bin/gh'),path.resolve('.bin/gh-manifest.json')]);
  const check=(p)=>seen.has(p);
  assert.deepEqual(publicGithubCliReadiness({
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_GITHUB_CLI_PILOT_ENABLED:'false',
  },check),{
    publicConnectors:true,pilotEnabled:false,gitBinaryPresent:true,
    ghArtifactsPresent:true,probeVerified:false,
  });
  assert.equal(publicGithubCliReadiness({
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_GITHUB_CLI_PILOT_ENABLED:'true',
  },check).pilotEnabled,true);
});

test('missing manifest cannot be reported as prepared; absent git is explicit',()=>{
  const check=(p)=>p===path.resolve('.bin/gh');
  const r=publicGithubCliReadiness({
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
  },check);
  assert.equal(r.ghArtifactsPresent,false);
  assert.equal(r.gitBinaryPresent,false);
  assert.equal(r.probeVerified,false);
});

test('private Pro does not inspect binaries or reveal public readiness',()=>{
  let inspected=0;
  const r=publicGithubCliReadiness({
    NYX_DEPLOYMENT_MODE:'private',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_GITHUB_CLI_PILOT_ENABLED:'true',
  },()=>{inspected++;return true});
  assert.equal(inspected,0);
  assert.equal(r.publicConnectors,false);
  assert.equal(r.pilotEnabled,false);
  assert.equal(r.ghArtifactsPresent,false);
});

test('MCP inventory advertises PR-ready and conditionally gated CLI probe',()=>{
  const source=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
  assert.match(source,/githubCliPilot: publicGithubCliReadiness\(\)/);
  assert.match(source,/\? \['nyx_connection_github_pr_ready_to_ref'\] : \[\]/);
  assert.match(source,/NYX_GITHUB_CLI_PILOT_ENABLED === 'true'/);
  assert.match(source,/nyx_connection_github_cli_probe/);
});
