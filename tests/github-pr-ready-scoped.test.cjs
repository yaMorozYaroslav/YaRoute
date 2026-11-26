const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');

const repo='owner/repo',head='nyx/review',base='tester';
const HEAD='a'.repeat(40),BASE='b'.repeat(40),NODE='PR_kwDOR3ady321';
const opts=['oauth:owner','connection',repo,13,HEAD,BASE];

function fixture({alreadyReady=false,wrongHead=false,protectedBase=false,
  externalHead=false,graphqlStatus=200,graphqlErrors=false}={}){
  const calls=[];
  let ready=alreadyReady, mutationCalls=0, tokenCalls=0;
  const registry={requireResource:async(owner,id,cap,r)=>{
    assert.equal(owner,'oauth:owner');assert.equal(id,'connection');assert.equal(r.id,repo);
    assert.ok(['pulls:read','pulls:write','resources:read'].includes(cap));
    return {provider:'github',installationId:'123'};
  }};
  const tokens={
    tokenFor:async()=> 'unit-test-token',
    tokenForReady:async(owner,id,installationId,repository,branch)=>{
      tokenCalls++;
      assert.deepEqual([owner,id,installationId,repository,branch],
        ['oauth:owner','connection','123',repo,head]);
      return 'unit-test-ready-token';
    },
  };
  const http=async(url,options)=>{
    const method=options.method, path=url.startsWith('https://api.github.com/repos/'+repo)
      ?url.slice(('https://api.github.com/repos/'+repo).length):url;
    calls.push({method,path});
    if(method==='GET'&&path==='')return okay({default_branch:'master'});
    if(method==='GET'&&path==='/pulls/13')return okay({
      number:13,node_id:NODE,state:'open',draft:!ready,merged:false,
      html_url:'https://github.com/'+repo+'/pull/13',
      head:{ref:head,sha:wrongHead?'c'.repeat(40):HEAD,
        repo:{full_name:externalHead?'different/repo':repo}},
      base:{ref:base,sha:BASE,repo:{full_name:repo}},
    });
    if(method==='GET'&&path==='/branches/'+encodeURIComponent(head))
      return okay({name:head,protected:false,commit:{sha:HEAD}});
    if(method==='GET'&&path==='/branches/'+base)
      return okay({name:base,protected:protectedBase,commit:{sha:BASE}});
    if(method==='POST'&&path==='https://api.github.com/graphql'){
      mutationCalls++;
      assert.equal(options.headers.Authorization,'Bearer unit-test-ready-token');
      const payload=JSON.parse(options.body);
      assert.equal(payload.variables.id,NODE);
      assert.match(payload.query,/markPullRequestReadyForReview/);
      assert.doesNotMatch(payload.query,/mergePullRequest/);
      if(graphqlStatus!==200)
        return {ok:false,status:graphqlStatus,text:async()=>JSON.stringify({message:'SECRET_RESPONSE'})};
      if(graphqlErrors)return okay({errors:[{message:'SENSITIVE_PRIVATE_ERROR'}]});
      ready=true;
      return okay({data:{markPullRequestReadyForReview:{pullRequest:{id:NODE,isDraft:false}}}});
    }
    throw Error('unexpected '+method+' '+path);
  };
  return {api:new GithubWriteConnector(registry,tokens,http),calls,
    get mutations(){return mutationCalls},get tokens(){return tokenCalls}};
}
function okay(value){return{ok:true,status:200,text:async()=>JSON.stringify(value)};}

test('scoped PR-ready GraphQL mutation makes exactly one POST and verifies REST result',async()=>{
  const f=fixture();
  const result=await f.api.readyReviewedNonDefault(...opts);
  assert.equal(result.ready,true);
  assert.equal(result.merged,false);
  assert.equal(result.graphQlMutation,true);
  assert.equal(f.mutations,1);
  assert.equal(f.tokens,1);
  assert.equal(result.headSha,HEAD);
  assert.ok(f.calls.filter(x=>x.path==='/pulls/13').length>=3);
});

test('already-ready PR is idempotent: no mutation or new scoped token',async()=>{
  const f=fixture({alreadyReady:true});
  const result=await f.api.readyReviewedNonDefault(...opts);
  assert.equal(result.alreadyReady,true);
  assert.equal(result.graphQlMutation,false);
  assert.equal(f.mutations,0);
  assert.equal(f.tokens,0);
});

test('stale, external, or protected inputs fail before mutation',async()=>{
  for(const p of [{wrongHead:true},{externalHead:true},{protectedBase:true}]){
    const f=fixture(p);
    await assert.rejects(()=>f.api.readyReviewedNonDefault(...opts),/GITHUB_/);
    assert.equal(f.mutations,0);
  }
  const f=fixture();
  await assert.rejects(()=>f.api.readyReviewedNonDefault(...opts.slice(0,5),'d'.repeat(40)),/GITHUB_/);
  assert.equal(f.mutations,0);
});

test('permission denied yields a safe error and never blind-retries GraphQL',async()=>{
  const f=fixture({graphqlStatus:403});
  await assert.rejects(()=>f.api.readyReviewedNonDefault(...opts),error=>{
    assert.equal(error.message,'GITHUB_READY_PROVIDER_FORBIDDEN');
    assert.doesNotMatch(error.message,/SECRET_RESPONSE|unit-test-ready-token/);
    return true;
  });
  assert.equal(f.mutations,1);
});

test('GraphQL errors do not leak provider text; REST readback controls outcome',async()=>{
  const f=fixture({graphqlErrors:true});
  await assert.rejects(()=>f.api.readyReviewedNonDefault(...opts),error=>{
    assert.equal(error.message,'GITHUB_READY_GRAPHQL_REJECTED');
    assert.doesNotMatch(error.message,/SENSITIVE_PRIVATE_ERROR/);
    return true;
  });
  assert.equal(f.mutations,1);
});

test('MCP exposes dedicated PR-ready only; no unrestricted GitHub command tool',()=>{
  const s=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
  assert.match(s,/nyx_connection_github_pr_ready_to_ref/);
  assert.match(s,/readyReviewedNonDefault/);
  assert.doesNotMatch(s,/registerTool\('nyx_connection_github_gh_exec'/);
  const app=fs.readFileSync('src/connectors/github-app.service.ts','utf8');
  assert.match(app,/async tokenForReady\(/);
  assert.match(app,/permissions:\{metadata:'read',pull_requests:'write',contents:'write'\}/);
});
