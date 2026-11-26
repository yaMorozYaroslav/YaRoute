const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {composeRuntimeHealthReport}=require('../dist/mcp/runtime-health-report');
const sha='a'.repeat(40);

test('public health checklist is a separate read-only endpoint with no private canonical reads',()=>{
 const src=fs.readFileSync('src/health.controller.ts','utf8');
 const start=src.indexOf("@Get('checklist')");
 const end=src.indexOf("@Get()",start);
 assert.ok(start>0&&end>start);
 const handler=src.slice(start,end);
 assert.match(src.slice(start-20,start),/@Public\(\)/);
 assert.match(handler,/fetchPublicGitHubEvidence\(runtimeCommit\)/);
 assert.match(handler,/deploymentMode: 'public'/);
 assert.doesNotMatch(handler,/bootstrap|\.mutate|\.execute|\.read\(|\.stat\(|\.copy|rclone\.run/);
 const report=composeRuntimeHealthReport({
  runtimeCommit:sha,service:'NestNyxPublicPilot',deploymentMode:'public',
 },{testerSha:sha,checks:[
  {name:'build',status:'completed',conclusion:'success',sha},
  {name:'audit',status:'completed',conclusion:'success',sha},
 ]});
 assert.equal(report.checks.find(x=>x.id==='canonical.registry').status,'UNVERIFIED');
 assert.equal(report.checks.find(x=>x.id==='ci.workflow').status,'PASS');
 assert.equal(report.testCaseCounts.passed,null);
 assert.equal(report.readOnly,true);
});
