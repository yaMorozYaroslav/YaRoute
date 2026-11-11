const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');
const SHA='0123456789abcdef0123456789abcdef01234567';
function setup(options={}){
 const {
  current=SHA,base='master',protectedBase=true,protectedTester=false,
  behind=0,ahead=6,pr=[],changedFiles=8,
 }=options;
 const calls=[],grants=[];
 const registry={requireResource:async(owner,id,cap,rule)=>{
  assert.equal(owner,'oauth:owner');assert.equal(id,'connection');
  assert.equal(rule.id,'owner/repo');
  assert.equal(rule.kind,'repository');assert.equal(rule.branch,'tester');
  assert.ok(['resources:read','pulls:read','pulls:write'].includes(cap));
  grants.push(cap);
  return {provider:'github',installationId:'7'};
 }};
 const creds={tokenFor:async()=> 'synthetic-token'};
 const http=async(url,options)=>{
  const suffix=url.split('/repos/owner/repo')[1];
  calls.push({suffix,method:options.method,
   body:options.body?JSON.parse(options.body):null});
  let value;
  if(options.method==='GET'&&suffix==='')value={default_branch:base};
  else if(options.method==='GET'&&suffix==='/branches/'+base)
   value={name:base,protected:protectedBase,commit:{sha:'a'.repeat(40)}};
  else if(options.method==='GET'&&suffix==='/branches/tester')
   value={name:'tester',protected:protectedTester,commit:{sha:current}};
  else if(options.method==='GET'&&suffix==='/compare/'+base+'...tester')
   value={status:'ahead',ahead_by:ahead,behind_by:behind,
    files:Array.from({length:changedFiles},(_,i)=>({filename:'tests/'+i+'.cjs'}))};
  else if(options.method==='GET'&&suffix==='/pulls')value=pr;
  else if(options.method==='POST'&&suffix==='/pulls'){
   value={number:29,draft:true,html_url:'https://github.com/owner/repo/pull/29',
    head:{ref:'tester',sha:current},base:{ref:base}};
  }else throw Error('UNEXPECTED_API_REQUEST:'+suffix);
  return {ok:true,status:200,text:async()=>JSON.stringify(value)};
 };
 return {api:new GithubWriteConnector(registry,creds,http),calls,grants};
}
const args=['oauth:owner','connection','owner/repo',SHA,'Promote reviewed tester','Only review'];
test('create draft tester PR after SHA, protected base, and ahead-only diff checks',async()=>{
 const t=setup();
 const result=await t.api.draftTesterRelease(...args);
 assert.deepEqual({base:result.base,draft:result.draft,existing:result.alreadyOpen,
  files:result.changedFiles},{base:'master',draft:true,existing:false,files:8});
 assert.deepEqual(t.calls.filter(x=>x.method==='POST').map(x=>x.body),[
  {head:'tester',base:'master',title:'Promote reviewed tester',
   body:'Only review',draft:true,maintainer_can_modify:false},
 ]);
 assert.ok(t.grants.includes('resources:read'));
 assert.ok(t.grants.includes('pulls:read'));
 assert.ok(t.grants.includes('pulls:write'));
 assert.equal(t.calls.filter(x=>x.method==='PUT'||x.suffix==='/git/refs').length,0);
});
test('existing draft PR is returned without creating another or modifying it',async()=>{
 const t=setup({pr:[{state:'open',number:28,draft:true,
  head:{ref:'tester'},base:{ref:'master'},
  html_url:'https://github.com/owner/repo/pull/28'}]});
 const result=await t.api.draftTesterRelease(...args);
 assert.equal(result.number,28);
 assert.equal(result.alreadyOpen,true);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('stale tester SHA fails closed before PR listing or creation',async()=>{
 const t=setup({current:'f'.repeat(40)});
 await assert.rejects(()=>t.api.draftTesterRelease(...args),/GITHUB_RELEASE_SOURCE_CHANGED/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('unprotected default, protected tester, and divergent release are refused',async()=>{
 for(const opts of [{protectedBase:false},{protectedTester:true},
                    {behind:1},{ahead:0},{changedFiles:0},{base:'tester'}]){
  const t=setup(opts);
  await assert.rejects(()=>t.api.draftTesterRelease(...args),
   /GITHUB_RELEASE_/);
  assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
 }
});
test('incomplete PR inventory fails closed, not duplicated',async()=>{
 const t=setup({pr:Array.from({length:30},(_,i)=>({number:i+1}))});
 await assert.rejects(()=>t.api.draftTesterRelease(...args),
  /GITHUB_RELEASE_PR_INVENTORY_INCOMPLETE/);
 assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
});
test('invalid SHA or missing review title is never sent to GitHub',async()=>{
 for(const tweak of [[3,'bad'],[4,'']]){
  const t=setup(),a=[...args];
  a[tweak[0]]=tweak[1];
  await assert.rejects(()=>t.api.draftTesterRelease(...a),/GITHUB_RELEASE_INPUT_INVALID/);
  assert.equal(t.calls.length,0);
 }
});
test('MCP exposes reviewed tester release only, without merge/deploy tool',()=>{
 const mcp=readFileSync('src/mcp/mcp.service.ts','utf8');
 const a=mcp.indexOf("server.registerTool('nyx_connection_github_tester_release_pr'");
 assert.ok(a>0);
 const text=mcp.slice(a,mcp.indexOf("server.registerTool('nyx_connection_github_commit_file'",a));
 assert.match(text,/expectedTesterSha:z\.string\(\)\.regex/);
 assert.match(text,/this\.connectorOwner\(\)/);
 assert.match(text,/this\.githubWrites\.draftTesterRelease/);
 assert.doesNotMatch(mcp,/server\.registerTool\('nyx_connection_github_merge'/);
});
