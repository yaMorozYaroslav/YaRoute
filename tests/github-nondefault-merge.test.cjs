const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');
const HEAD='1'.repeat(40),BASE='2'.repeat(40),MERGE='3'.repeat(40);
const repo='owner/repo';
const opts=['oauth:owner','connection',repo,34,HEAD,BASE];
function setup({base='tester',protectedBase=false,wrongHead=false,wrongBase=false,
                runConclusion='success',runStatus='completed',draft=false,
                externalHead=false}={}){
 const calls=[];
 const registry={requireResource:async(o,id,cap,r)=>{
  assert.equal(o,'oauth:owner');assert.equal(id,'connection');
  assert.equal(r.id,repo);
  assert.ok(['pulls:read','pulls:write','resources:read','ci:read'].includes(cap));
  return {provider:'github',installationId:'11'};
 }};
 const tokens={tokenFor:async()=> 'synthetic-token'};
 const http=async(url,options)=>{
  const p=url.split('/repos/'+repo)[1];
  calls.push({method:options.method,path:p,body:options.body?JSON.parse(options.body):null});
  let payload;
  if(options.method==='GET'&&p==='/pulls/34')payload={
    state:'open',draft,mergeable:true,
    head:{ref:'nyx/review',sha:wrongHead?'f'.repeat(40):HEAD,
      repo:{full_name:externalHead?'other/repo':repo}},
    base:{ref:base,sha:wrongBase?'f'.repeat(40):BASE,
      repo:{full_name:repo}},
  };
  else if(options.method==='GET'&&p==='')payload={default_branch:'master'};
  else if(options.method==='GET'&&p==='/branches/'+base)
   payload={name:base,protected:protectedBase,commit:{sha:wrongBase?'f'.repeat(40):BASE}};
  else if(options.method==='GET'&&p==='/actions/runs?head_sha='+HEAD+'&per_page=10')
   payload={workflow_runs:[{name:'CI',head_sha:HEAD,head_branch:'nyx/review',
     status:runStatus,conclusion:runConclusion}]};
  else if(options.method==='PUT'&&p==='/pulls/34/merge')
   payload={merged:true,sha:MERGE};
  else throw Error('UNKNOWN:'+p);
  return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
 };
 return {api:new GithubWriteConnector(registry,tokens,http),calls};
}
test('reviewed nondefault merge checks CI, base, head before its only write',async()=>{
 const t=setup(),result=await t.api.mergeReviewedNonDefault(...opts);
 assert.equal(result.merged,true);
 assert.equal(result.base,'tester');
 assert.equal(result.mergeCommitSha,MERGE);
 const writes=t.calls.filter(x=>x.method!=='GET');
 assert.deepEqual(writes,[{method:'PUT',path:'/pulls/34/merge',
   body:{sha:HEAD,merge_method:'merge'}}]);
 assert.ok(t.calls.some(x=>x.path==='/actions/runs?head_sha='+HEAD+'&per_page=10'));
});
test('main/master and arbitrary protected destination can never merge',async()=>{
 for(const params of [{base:'main'},{base:'master'},{base:'release',protectedBase:true}]){
  const t=setup(params);
  await assert.rejects(()=>t.api.mergeReviewedNonDefault(...opts));
  assert.equal(t.calls.filter(x=>x.method!=='GET').length,0);
 }
});
test('refuses stale SHAs, draft PRs, external heads and unsuccessful or pending CI',async()=>{
 for(const params of [{wrongHead:true},{wrongBase:true},{draft:true},
                      {externalHead:true},{runConclusion:'failure'},
                      {runStatus:'in_progress',runConclusion:null}]){
  const t=setup(params);
  await assert.rejects(()=>t.api.mergeReviewedNonDefault(...opts));
  assert.equal(t.calls.filter(x=>x.method!=='GET').length,0);
 }
});
test('MCP release tooling has safe nondefault merge but no generic production merge',()=>{
 const s=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 assert.match(s,/nyx_connection_github_merge_reviewed_nondefault/);
 assert.match(s,/mergeReviewedNonDefault/);
 assert.doesNotMatch(s,/server\.registerTool\('nyx_connection_github_merge'/);
});

test('ready-for-review PR creation targets only verified unprotected nondefault branches',async()=>{
 const calls=[];
 const registry={requireResource:async()=>({provider:'github',installationId:'1'})};
 const http=async(url,options)=>{
  const p=url.split('/repos/owner/repo')[1];
  calls.push({p,method:options.method,body:options.body?JSON.parse(options.body):null});
  let result;
  if(options.method==='GET'&&p==='')result={default_branch:'master'};
  else if(options.method==='GET'&&p==='/branches/tester')
   result={name:'tester',protected:false,commit:{sha:BASE}};
  else if(options.method==='GET'&&p==='/branches/nyx%2Freview')
   result={name:'nyx/review',protected:false,commit:{sha:HEAD}};
  else if(options.method==='POST'&&p==='/pulls')
   result={number:37,draft:false,head:{ref:'nyx/review',sha:HEAD},
     base:{ref:'tester'},html_url:'https://github.com/owner/repo/pull/37'};
  else throw Error('unexpected '+p);
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};
 };
 const t=new GithubWriteConnector(registry,{tokenFor:async()=> 'synthetic'},http);
 const result=await t.openReviewedNonDefault('oauth:owner','connection',repo,
  'nyx/review','tester','Review verified change','',HEAD,BASE);
 assert.equal(result.readyForReview,true);
 assert.equal(result.merged,false);
 assert.deepEqual(calls.filter(x=>x.method==='POST').map(x=>x.body),[
  {head:'nyx/review',base:'tester',title:'Review verified change',
   body:'',draft:false,maintainer_can_modify:false},
 ]);
 await assert.rejects(()=>t.openReviewedNonDefault('oauth:owner','connection',repo,
  'nyx/review','master','bad','',HEAD,BASE));
 assert.equal(calls.filter(x=>x.method==='POST').length,1);
 const mcp=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 assert.match(mcp,/nyx_connection_github_reviewed_pr_to_ref/);
 assert.match(mcp,/openReviewedNonDefault/);
});
