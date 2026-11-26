const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');

const OWNER='oauth:synthetic-owner',ID='connection',REPO='owner/repo';
const HEAD='a'.repeat(40),BASE='b'.repeat(40),OLD_BASE='c'.repeat(40);
const MERGE='d'.repeat(40),opts=[OWNER,ID,REPO,104,HEAD,BASE];

function fixture({stalePrBase=true,changedLiveBase=false,retargetOnReadback=false,
  protectedBase=false,wrongHead=false,ciPassed=true}={}){
  const calls=[];
  let readPr=0;
  const registry={requireResource:async(owner,id,cap,rule)=>{
    assert.equal(owner,OWNER);assert.equal(id,ID);assert.equal(rule.id,REPO);
    assert.ok(['pulls:read','resources:read','ci:read','pulls:write'].includes(cap));
    return{provider:'github',installationId:'123'};
  }};
  const credentials={tokenFor:async()=> 'synthetic-scoped-token'};
  const http=async(url,options)=>{
    const suffix=url.slice(('https://api.github.com/repos/'+REPO).length);
    calls.push({method:options.method,suffix});
    if(options.method==='GET'&&suffix==='/pulls/104'){
      ++readPr;
      return ok({
        state:'open',draft:false,mergeable:true,
        head:{ref:'nyx/review',sha:wrongHead?OLD_BASE:HEAD,repo:{full_name:REPO}},
        base:{ref:retargetOnReadback&&readPr>1?'other':'tester',
          sha:stalePrBase?OLD_BASE:BASE,repo:{full_name:REPO}},
      });
    }
    if(options.method==='GET'&&suffix==='')return ok({default_branch:'master'});
    if(options.method==='GET'&&suffix==='/branches/tester')
      return ok({name:'tester',protected:protectedBase,
        commit:{sha:changedLiveBase?OLD_BASE:BASE}});
    if(options.method==='GET'&&suffix==='/actions/runs?head_sha='+HEAD+'&per_page=10')
      return ok({workflow_runs:[{name:'CI',head_sha:HEAD,head_branch:'nyx/review',
        status:'completed',conclusion:ciPassed?'success':'failure'}]});
    if(options.method==='PUT'&&suffix==='/pulls/104/merge'){
      assert.deepEqual(JSON.parse(options.body),
        {sha:HEAD,merge_method:'merge'});
      return ok({merged:true,sha:MERGE});
    }
    throw Error('unexpected route: '+options.method+' '+suffix);
  };
  return{api:new GithubWriteConnector(registry,credentials,http),calls};
}
function ok(data){return{ok:true,status:200,text:async()=>JSON.stringify(data)};}

test('merge accepts stale PR base.sha only if live Tester tip matches exact expectedBaseSha',async()=>{
  const f=fixture();
  const result=await f.api.mergeReviewedNonDefault(...opts);
  assert.equal(result.merged,true);
  assert.equal(result.mergeCommitSha,MERGE);
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
  assert.equal(f.calls.filter(x=>x.suffix==='/branches/tester').length,2);
});

test('stale PR base.sha never masks a moved or protected live Tester branch',async()=>{
  for(const params of [{changedLiveBase:true},{protectedBase:true}]){
    const f=fixture(params);
    await assert.rejects(()=>f.api.mergeReviewedNonDefault(...opts),
      /GITHUB_REVIEW_BASE_CHANGED_OR_PROTECTED/);
    assert.equal(f.calls.some(x=>x.method==='PUT'),false);
  }
});

test('changed target ref, changed head or failed CI abort before merge mutation',async()=>{
  for(const params of [{retargetOnReadback:true},{wrongHead:true},{ciPassed:false}]){
    const f=fixture(params);
    await assert.rejects(()=>f.api.mergeReviewedNonDefault(...opts),/GITHUB_/);
    assert.equal(f.calls.some(x=>x.method==='PUT'),false);
  }
});
