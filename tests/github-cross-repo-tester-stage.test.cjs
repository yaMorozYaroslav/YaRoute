const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');
const SOURCE_SHA='1'.repeat(40),TESTER_SHA='2'.repeat(40);
const SRC_TREE='3'.repeat(40),DST_TREE='4'.repeat(40);
const BLOB_SHA='5'.repeat(40),BUILT_TREE='6'.repeat(40),REVIEW_SHA='7'.repeat(40);
const PATH='src/connectors/tenant-mega-enrollment.service.ts';
const SRC=['linux','ofpower/YaRoute-Dev'].join(''),DST=['yaMoroz','Yaroslav/YaRoute'].join('');
const TEXT="export const publicMegaLogin = true;\n";
const REVIEW='nyx/tenant-mega-verified-stage';
const args=['oauth:owner','source-id','destination-id',
 SRC,DST,'main',SOURCE_SHA,TESTER_SHA,REVIEW,[PATH]];
function harness({sourceSha=SOURCE_SHA,testerSha=TESTER_SHA,
                   protectedTester=false,missing=false,wrongSize=false,
                   truncated=false}={}){
 const calls=[],grants=[];
 const registry={requireResource:async (owner,id,cap,rule)=>{
  assert.equal(owner,'oauth:owner');
  assert.ok(id==='source-id'||id==='destination-id');
  const expectedRepo=id==='source-id'?SRC:DST;
  assert.equal(rule.id,expectedRepo);
  assert.equal(rule.kind,'repository');
  assert.ok(['resources:read','contents:write'].includes(cap));
  grants.push({id,cap,rule});
  return {provider:'github',installationId:id==='source-id'?'111':'222'};
 }};
 const credentials={tokenFor:async (_owner,id,install,repo,cap)=>{
  assert.equal(install,id==='source-id'?'111':'222');
  assert.equal(repo,id==='source-id'?SRC:DST);
  return 'synthetic-scoped-token';
 }};
 const http=async (url,options)=>{
  const part=url.includes(SRC)?SRC:DST;
  const suffix=url.split('/repos/'+part)[1];
  calls.push({repo:part,suffix,method:options.method,
    body:options.body?JSON.parse(options.body):null});
  let output;
  if(options.method==='GET'&&suffix==='')
   output={default_branch:part===SRC?'main':'master'};
  else if(options.method==='GET'&&suffix==='/git/ref/heads/main')
   output={object:{sha:sourceSha}};
  else if(options.method==='GET'&&suffix==='/git/ref/heads/tester')
   output={object:{sha:testerSha}};
  else if(options.method==='GET'&&suffix==='/branches/tester')
   output={name:'tester',protected:protectedTester,commit:{sha:testerSha}};
  else if(options.method==='GET'&&suffix==='/git/commits/'+SOURCE_SHA)
   output={tree:{sha:SRC_TREE}};
  else if(options.method==='GET'&&suffix==='/git/commits/'+TESTER_SHA)
   output={tree:{sha:DST_TREE}};
  else if(options.method==='GET'&&suffix==='/git/trees/'+SRC_TREE+'?recursive=1')
   output={truncated,tree:missing?[]:[{type:'blob',path:PATH,sha:BLOB_SHA,
     size:wrongSize?1:Buffer.byteLength(TEXT)}]};
  else if(options.method==='GET'&&suffix==='/git/blobs/'+BLOB_SHA)
   output={encoding:'base64',content:Buffer.from(TEXT).toString('base64')};
  else if(options.method==='POST'&&suffix==='/git/trees')
   output={sha:BUILT_TREE};
  else if(options.method==='POST'&&suffix==='/git/commits')
   output={sha:REVIEW_SHA};
  else if(options.method==='POST'&&suffix==='/git/refs')
   output={ref:'refs/heads/'+REVIEW,object:{sha:REVIEW_SHA}};
  else throw Error('UNKNOWN_MOCK_ROUTE:'+part+suffix);
  return {ok:true,status:200,text:async()=>JSON.stringify(output)};
 };
 return {api:new GithubWriteConnector(registry,credentials,http),calls,grants};
}
test('NYX stages only an exact Dev SHA into new review branch from exact tester SHA',async()=>{
 const t=harness();
 const result=await t.api.stageTesterFromDev(...args);
 assert.equal(result.branch,REVIEW);
 assert.equal(result.base,'tester');
 assert.equal(result.merged,false);
 assert.equal(result.fileCount,1);
 assert.equal(result.sourceSha,SOURCE_SHA);
 assert.equal(result.testerSha,TESTER_SHA);
 assert.equal(result.reviewSha,REVIEW_SHA);
 const writes=t.calls.filter(x=>x.method==='POST'||x.method==='PUT');
 assert.deepEqual(writes.map(x=>[x.repo,x.suffix]),[
  [DST,'/git/trees'],[DST,'/git/commits'],[DST,'/git/refs']]);
 assert.deepEqual(writes[0].body,{base_tree:DST_TREE,
  tree:[{path:PATH,mode:'100644',type:'blob',content:TEXT}]});
 assert.deepEqual(writes[1].body.parents,[TESTER_SHA]);
 assert.equal(writes[2].body.ref,'refs/heads/'+REVIEW);
 assert.equal(writes.filter(x=>x.suffix==='/pulls'||x.suffix.includes('merge')).length,0);
 assert.ok(t.grants.some(x=>x.id==='source-id'&&x.cap==='resources:read'));
 assert.ok(t.grants.some(x=>x.id==='destination-id'&&x.cap==='contents:write'));
});
test('missing app selection or stale tester SHA never creates a PR or branch',async()=>{
 for(const bad of [{sourceSha:'f'.repeat(40)},{testerSha:'f'.repeat(40)},
                   {protectedTester:true},{missing:true},{wrongSize:true},
                   {truncated:true}]){
  const t=harness(bad);
  await assert.rejects(()=>t.api.stageTesterFromDev(...args));
  assert.equal(t.calls.filter(x=>x.method==='POST').length,0);
 }
});
test('invalid repositories, protected base and forbidden infrastructure paths fail locally',async()=>{
 const candidates=[
  args.map((x,i)=>i===4?DST.replace('/YaRoute','/Other'):x),
  args.map((x,i)=>i===3?DST.replace('/YaRoute','/YaRoute-Dev'):x),
  args.map((x,i)=>i===5?'master':x),
  args.map((x,i)=>i===8?'master':x),
  args.map((x,i)=>i===9?['.github/workflows/deploy.yml']:x),
  args.map((x,i)=>i===9?['scripts/token-handoff.mjs']:x),
  args.map((x,i)=>i===9?['.env']:x),
  args.map((x,i)=>i===9?[]:x),
 ];
 for(const a of candidates){
  const t=harness();
  await assert.rejects(()=>t.api.stageTesterFromDev(...a));
  assert.equal(t.calls.length,0);
 }
});
test('NYX exposes dual owner-scoped source/destination MCP inputs without any merge tool',()=>{
 const s=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 assert.match(s,/nyx_connection_github_stage_tester_from_dev/);
 assert.match(s,/sourceConnectionId:z\.string\(\)\.uuid\(\)/);
 assert.match(s,/destinationConnectionId:z\.string\(\)\.uuid\(\)/);
 assert.match(s,/stageTesterFromDev\(this\.connectorOwner\(\)/);
 assert.doesNotMatch(s,/server\.registerTool\('nyx_connection_github_merge'/);
});
