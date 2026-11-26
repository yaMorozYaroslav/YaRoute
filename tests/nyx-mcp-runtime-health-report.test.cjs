const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assessGitHubEvidence, fetchPublicGitHubEvidence,
  composeRuntimeHealthReport } = require('../dist/mcp/runtime-health-report');

const SHA='a'.repeat(40);
const OTHER='b'.repeat(40);
const success={
  testerSha: SHA,
  checks:[
    {name:'build',status:'completed',conclusion:'success',sha:SHA},
    {name:'audit',status:'completed',conclusion:'success',sha:SHA},
    {name:'GitGuardian Security Checks',status:'completed',conclusion:'success',sha:SHA},
  ],
};
const get=(report,id)=>report.checks.find(c=>c.id===id);

test('exact tester runtime and CI checks are verified but individual tests are not invented',()=>{
 const r=composeRuntimeHealthReport({
  runtimeCommit:SHA,service:'NestNyxPublicPilot',deploymentMode:'public',
 },success);
 assert.equal(r.schema,'nyx.runtime-checklist.v2');
 assert.equal(r.mode,'public');
 assert.equal(get(r,'deployment.commit').status,'PASS');
 assert.equal(get(r,'ci.workflow').status,'PASS');
 assert.equal(get(r,'canonical.registry').status,'UNVERIFIED');
 assert.equal(get(r,'canonical.bundles').status,'UNVERIFIED');
 assert.equal(get(r,'cli.contracts').status,'UNVERIFIED');
 assert.equal(get(r,'ci.functions').status,'UNVERIFIED');
 assert.equal(r.testCaseCounts.passed,null);
 assert.equal(r.testCaseCounts.skipped,null);
 assert.equal(r.overall,'NEEDS_REVIEW');
 assert.equal(r.productionApproved,false);
 assert.equal(r.readOnly,true);
});
test('stale runtime cannot pass tester equality and older passing check runs are ignored',()=>{
 const r=assessGitHubEvidence(OTHER,success);
 assert.equal(r.commit.status,'WARN');
 assert.equal(r.ci.status,'UNVERIFIED');
 assert.deepEqual(r.ci.details.checks,[]);
});
test('real failing and pending checks never show success',()=>{
 const failed=assessGitHubEvidence(SHA,{
  testerSha:SHA,
  checks:[
   {name:'build',status:'completed',conclusion:'failure',sha:SHA},
   {name:'GitGuardian Security Checks',status:'completed',conclusion:'success',sha:SHA},
  ],
 });
 assert.equal(failed.ci.status,'FAIL');
 const pending=assessGitHubEvidence(SHA,{
  testerSha:SHA,checks:[{name:'build',status:'in_progress',conclusion:null,sha:SHA}],
 });
 assert.equal(pending.ci.status,'UNVERIFIED');
});
test('GitHub API outage, invalid SHA, or untrusted source data stays unverified',async()=>{
 const data=await fetchPublicGitHubEvidence('not-sha',async()=>{throw Error('must not fetch');});
 assert.equal(data.error,'COMMIT_UNVERIFIED');
 assert.equal(assessGitHubEvidence('',data).commit.status,'UNVERIFIED');
 const unavailable=await fetchPublicGitHubEvidence(SHA,async()=>{throw Error('sensitive backend details');});
 assert.equal(unavailable.error,'PUBLIC_GITHUB_UNAVAILABLE');
 assert.ok(!JSON.stringify(unavailable).includes('sensitive backend details'));
});
test('public GitHub requests use only fixed repo and exact observed SHA',async()=>{
 const urls=[];
 const data=await fetchPublicGitHubEvidence(SHA,async url=>{
  urls.push(url);
  if(url.endsWith('/branches/tester'))return {commit:{sha:SHA}};
  return {check_runs:success.checks.map(x=>({...x,head_sha:SHA}))};
 });
 assert.equal(data.testerSha,SHA);
 assert.equal(data.checks.length,3);
 assert.deepEqual(urls,[
  'https://api.github.com/repos/yaMorozYaroslav/YaRoute/branches/tester',
  'https://api.github.com/repos/yaMorozYaroslav/YaRoute/commits/'+SHA+'/check-runs?per_page=100',
 ]);
});
// The MCP tool registration is intentionally not present in the Tester code path yet.
// Large-file staging for src/mcp/mcp.service.ts needs a reviewed NestNyx size-cap fix.
// This suite validates only the pure public CI evidence collector.
