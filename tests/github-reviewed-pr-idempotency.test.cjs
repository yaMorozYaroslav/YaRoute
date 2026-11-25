const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GithubWriteConnector } = require('../dist/connectors/github-writes');

const repo='yaMorozYaroslav/MyWeb';
const head='nyx/review-contacts-test';
const base='tester';
const headSha='d557a98fceb51f8862dcec3f57a7b6f389f5147e';
const baseSha='fcef9d49434945e4419e97ded3dfa8c165c726c1';
const prior=(merged=false)=>({
  number:10,html_url:'https://github.com/'+repo+'/pull/10',
  state:merged?'closed':'open',draft:false,
  merged_at:merged?'2026-11-25T21:20:07Z':null,
  head:{ref:head,sha:headSha,repo:{full_name:repo}},
  base:{ref:base,sha:merged?'0a6ff56024da356868a4cc083d1757fa4c3799c7':baseSha,
    repo:{full_name:repo}},
});
function mock(options={}) {
  const calls=[],pulls=options.pulls||[];
  const credentials={tokenFor:async()=> 'mock-install-token'};
  const registry={requireResource:async (_owner,_id,capability,scope)=>{
    assert.equal(scope.id,repo);
    assert.ok(['pulls:read','pulls:write','resources:read'].includes(capability));
    return {provider:'github',installationId:'123'};
  }};
  const http=async(url,req)=>{
    const suffix=url.slice(('https://api.github.com/repos/'+repo).length);
    calls.push({method:req.method,suffix});
    if(req.method==='GET'&&suffix==='')return ok({default_branch:'master'});
    if(req.method==='GET'&&suffix==='/branches/'+encodeURIComponent(head))
      return ok({name:head,protected:false,commit:{sha:headSha}});
    if(req.method==='GET'&&suffix==='/branches/tester')
      return ok({name:base,protected:false,commit:{sha:baseSha}});
    if(req.method==='GET'&&suffix==='/pulls?state=all&per_page=100')
      return ok(pulls);
    if(req.method==='POST'&&suffix==='/pulls'){
      if(options.ambiguous)pulls.push(prior());
      return {ok:false,status:422,headers:{get:()=>null},
        text:async()=>JSON.stringify({message:'PRIVATE_PROVIDER_DETAILS'})};
    }
    throw Error('unexpected GitHub route/method: '+suffix+' '+req.method);
  };
  return {connector:new GithubWriteConnector(registry,credentials,http),calls,pulls};
}
function ok(value){return {ok:true,status:200,text:async()=>JSON.stringify(value)};}
function create(writes){
  return writes.openReviewedNonDefault('oauth:owner','connection',repo,head,base,
    'Reviewed Contacts fix','Tester only',headSha,baseSha);
}
test('existing merged review PR is returned without a write after a client retry',async()=>{
  const f=mock({pulls:[prior(true)]});
  const output=await create(f.connector);
  assert.equal(output.pr,10);
  assert.equal(output.alreadyExists,true);
  assert.equal(output.merged,true);
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
test('PR accepted but GitHub responds 422 is reconciled once, with no duplicate POST',async()=>{
  const f=mock({ambiguous:true});
  const output=await create(f.connector);
  assert.equal(output.pr,10);
  assert.equal(output.reconciledAfterCreateError,true);
  assert.equal(output.merged,false);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('unrelated provider validation error is not suppressed',async()=>{
  const f=mock();
  await assert.rejects(()=>create(f.connector),/GITHUB_PROVIDER_VALIDATION_FAILED/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('existing PR with different head SHA is rejected before write',async()=>{
  const mismatch=prior();
  mismatch.head.sha='0000000000000000000000000000000000000000';
  const f=mock({pulls:[mismatch]});
  await assert.rejects(()=>create(f.connector),/GITHUB_REVIEW_EXISTING_PR_MISMATCH/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
