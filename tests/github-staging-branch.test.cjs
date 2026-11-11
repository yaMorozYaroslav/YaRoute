const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');
const BASE_SHA='0123456789abcdef0123456789abcdef01234567';
function makeFixture({protectedBase=false,sourceSha=BASE_SHA,defaultBranch='master'}={}) {
 const calls=[],grants=[];
 const registry={requireResource:async(owner,id,cap,boundary)=>{
   assert.equal(owner,'oauth:owner');assert.equal(id,'conn');
   assert.equal(boundary.id,'owner/repo');assert.equal(boundary.kind,'repository');
   assert.ok(['contents:write','pulls:write'].includes(cap));
   grants.push({cap,branch:boundary.branch});
   return {provider:'github',installationId:'73'};
 }};
 const tokens={tokenFor:async()=> 'scope-token'};
 const http=async(url,init)=>{
   const path=url.split('/repos/owner/repo')[1];
   calls.push({path,method:init.method,body:init.body});
   let value;
   if(init.method==='GET'&&path==='')value={default_branch:defaultBranch};
   else if(init.method==='GET'&&path==='/git/ref/heads/tester')value={object:{sha:sourceSha}};
   else if(init.method==='GET'&&path==='/branches/tester')
     value={name:'tester',protected:protectedBase};
   else if(init.method==='POST'&&path==='/git/refs')value={ref:JSON.parse(init.body).ref};
   else if(init.method==='POST'&&path==='/pulls') {
     const body=JSON.parse(init.body);
     value={draft:true,number:43,html_url:'https://github.com/owner/repo/pull/43',
       base:{ref:body.base},head:{ref:body.head}};
   } else throw Error('UNEXPECTED_API_REQUEST:'+path);
   return {ok:true,status:200,text:async()=>JSON.stringify(value)};
 };
 return {api:new GithubWriteConnector(registry,tokens,http),calls,grants};
}
test('create from tester with exact SHA, leaves tester/master untouched',async()=>{
 const t=makeFixture();
 const value=await t.api.createFromNonDefault('oauth:owner','conn','owner/repo',
   'nyx/rclone-stage-fix','tester',BASE_SHA);
 assert.equal(value.from,'tester');assert.equal(value.baseSha,BASE_SHA);
 assert.equal(value.defaultBranchUntouched,true);
 assert.deepEqual(t.calls.map(x=>x.method),['GET','GET','GET','POST']);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,1);
 assert.deepEqual(JSON.parse(t.calls[3].body),
   {ref:'refs/heads/nyx/rclone-stage-fix',sha:BASE_SHA});
 assert.ok(t.grants.some(x=>x.branch==='tester'));
});
test('refuses stale staging head without creating a branch',async()=>{
 const t=makeFixture({sourceSha:'f'.repeat(40)});
 await assert.rejects(()=>t.api.createFromNonDefault('oauth:owner','conn','owner/repo',
   'nyx/rclone-stage-fix','tester',BASE_SHA),/GITHUB_STAGING_BASE_CHANGED/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('refuses sources marked protected',async()=>{
 const t=makeFixture({protectedBase:true});
 await assert.rejects(()=>t.api.createFromNonDefault('oauth:owner','conn','owner/repo',
   'nyx/fix','tester',BASE_SHA),/GITHUB_SOURCE_PROTECTION_UNVERIFIED/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('never bases staged branch on main or master or default',async()=>{
 for(const ref of ['main','master','refs/heads/master']){
   const t=makeFixture();
   await assert.rejects(()=>t.api.createFromNonDefault('oauth:owner','conn','owner/repo',
     'nyx/fix',ref,BASE_SHA),/GITHUB_PROTECTED_OR_INVALID_BRANCH/);
   assert.equal(t.calls.length,0);
 }
 const t=makeFixture({defaultBranch:'tester'});
 await assert.rejects(()=>t.api.createFromNonDefault('oauth:owner','conn','owner/repo',
   'nyx/fix','tester',BASE_SHA),/GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('requires nyx review branch, nondefault source and valid SHA',async()=>{
 for(const [head,base,sha] of [
   ['feature/fix','tester',BASE_SHA],['nyx/fix','nyx/fix',BASE_SHA],
   ['nyx/fix','tester','oops'],
 ]) {
   const t=makeFixture();
   await assert.rejects(()=>t.api.createFromNonDefault('oauth:owner','conn',
     'owner/repo',head,base,sha));
   assert.equal(t.calls.length,0);
 }
});
test('draft PR to tester is unmerged and never targets default',async()=>{
 const t=makeFixture();
 const value=await t.api.draftPullToNonDefault('oauth:owner','conn','owner/repo',
   'nyx/staging-fix','tester','Stage fix','Reviewed code only');
 assert.equal(value.base,'tester');assert.equal(value.draft,true);
 const p=JSON.parse(t.calls[1].body);
 assert.deepEqual({head:p.head,base:p.base,draft:p.draft,maintainer_can_modify:p.maintainer_can_modify},
   {head:'nyx/staging-fix',base:'tester',draft:true,maintainer_can_modify:false});
 assert.deepEqual(t.calls.map(x=>x.method),['GET','POST']);
});
test('draft PR denies main/master and the repository default',async()=>{
 for(const base of ['main','master']){
   const t=makeFixture();
   await assert.rejects(()=>t.api.draftPullToNonDefault('oauth:owner','conn','owner/repo',
     'nyx/staging-fix',base,'Bad'),/GITHUB_PROTECTED_OR_INVALID_BRANCH/);
   assert.equal(t.calls.length,0);
 }
 const t=makeFixture({defaultBranch:'tester'});
 await assert.rejects(()=>t.api.draftPullToNonDefault('oauth:owner','conn','owner/repo',
   'nyx/staging-fix','tester','No'),/GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('MCP exposes only SHA-guarded staging create and draft PR, no protected merge tools',()=>{
 const fs=require('node:fs'),mcp=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 assert.ok(mcp.includes("server.registerTool('nyx_connection_github_branch_from_ref'"));
 assert.ok(mcp.includes('expectedBaseSha:z.string().regex(/^[a-f0-9]{40}$/)'));
 assert.ok(mcp.includes("server.registerTool('nyx_connection_github_draft_pr_to_ref'"));
 assert.ok(!mcp.includes("server.registerTool('nyx_connection_github_merge'"));
});
