const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');

const SHA='0123456789abcdef0123456789abcdef01234567';
function fixture(onRequest){
 const requests=[],grants=[];
 const registry={requireResource:async(owner,id,cap,rule)=>{
  grants.push({owner,id,cap,rule});
  if(owner!=='oauth:alice'||id!=='conn'||rule.kind!=='repository'||rule.id!=='org/repo')
   throw Error('CONNECTOR_NOT_FOUND');
  if(!['contents:write','pulls:write','issues:write'].includes(cap))
   throw Error('CONNECTOR_FORBIDDEN');
  return {provider:'github',installationId:'123'};
 }};
 const creds={tokenFor:async(owner,id,inst,repo,cap,boundary)=>{
  assert.deepEqual([owner,id,inst,repo],['oauth:alice','conn','123','org/repo']);
  assert.ok(['contents:write','pulls:write','issues:write'].includes(cap));
  return 'restricted-write-token';
 }};
 const http=async(url,options)=>{
  requests.push({url,options});
  assert.equal(options.headers.Authorization,'Bearer restricted-write-token');
  const item=onRequest(url,options);
  return {ok:true,status:201,text:async()=>JSON.stringify(item)};
 };
 return {api:new GithubWriteConnector(registry,creds,http),requests,grants};
}

test('GitHub branch creation uses exact repo and nyx branch, never default-branch write',async()=>{
 const {api,requests}=fixture((url,init)=>{
  if(init.method==='GET'&&url.endsWith('/org/repo'))
    return {default_branch:'master'};
  if(init.method==='GET'&&url.endsWith('/git/ref/heads/master'))
    return {object:{sha:SHA}};
  if(init.method==='POST'&&url.endsWith('/git/refs')){
   assert.deepEqual(JSON.parse(init.body),{ref:'refs/heads/nyx/test-change',sha:SHA});
   return {ref:'refs/heads/nyx/test-change'};
  }
  throw Error('Unexpected request '+url);
 });
 const result=await api.createBranch('oauth:alice','conn','org/repo','nyx/test-change');
 assert.equal(result.branch,'nyx/test-change');
 assert.deepEqual(requests.map(r=>r.options.method),['GET','GET','POST']);
 assert.equal(requests.every(r=>r.url.startsWith('https://api.github.com/repos/org/repo/')),true);
 await assert.rejects(()=>api.createBranch('oauth:alice','conn','org/repo','master'),
  /GITHUB_STAGING_BRANCH_REQUIRED/);
 assert.equal(requests.length,3);
});

test('GitHub file commits require nyx review branch and block workflow/hosting edits',async()=>{
 const {api,requests}=fixture((url,init)=>{
  assert.ok(url.endsWith('/contents/src/example.ts'));
  assert.equal(init.method,'PUT');
  const payload=JSON.parse(init.body);
  assert.equal(payload.branch,'nyx/testing');
  assert.equal(Buffer.from(payload.content,'base64').toString(),'export const x=1;');
  assert.equal(payload.sha,SHA);
  return {commit:{sha:SHA}};
 });
 const result=await api.commitFile('oauth:alice','conn','org/repo',
  'nyx/testing','src/example.ts','export const x=1;','Update example',SHA);
 assert.equal(result.commitSha,SHA);
 assert.equal(requests.length,1);
 for(const path of ['.github/workflows/deploy-heroku.yml','scripts/build-info.mjs',
  'broker/heroku-readonly.mjs','config/heroku-public.json',
  'Procfile','package.json','.env','src/connectors/heroku-broker.client.ts']){
  await assert.rejects(()=>api.commitFile('oauth:alice','conn','org/repo',
   'nyx/testing',path,'text','test'),/GITHUB_INFRASTRUCTURE_WRITE_FORBIDDEN/);
 }
 await assert.rejects(()=>api.commitFile('oauth:alice','conn','org/repo',
  'main','src/example.ts','oops','test'),/GITHUB_STAGING_BRANCH_REQUIRED/);
 assert.equal(requests.length,1);
});

test('GitHub PR tool only opens draft review to default branch',async()=>{
 const {api,requests}=fixture((url,init)=>{
  if(init.method==='GET')return{default_branch:'master'};
  const body=JSON.parse(init.body);
  assert.equal(init.method,'POST');
  assert.equal(body.base,'master');
  assert.equal(body.head,'nyx/feature');
  assert.equal(body.draft,true);
  assert.equal(body.maintainer_can_modify,false);
  return {number:12,draft:true,html_url:'https://github.com/org/repo/pull/12'};
 });
 const result=await api.draftPull('oauth:alice','conn','org/repo','nyx/feature','Review staged edits');
 assert.equal(result.draft,true);
 assert.equal(result.number,12);
 assert.equal(requests.length,2);
 await assert.rejects(()=>api.draftPull('oauth:alice','conn','org/repo','master','No'),
  /GITHUB_STAGING_BRANCH_REQUIRED/);
});

test('Issue tool honors GitHub App issues:write and exact repository',async()=>{
 const {api,grants}=fixture((url,init)=>{
  assert.ok(url.endsWith('/org/repo/issues'));
  assert.equal(init.method,'POST');
  assert.equal(JSON.parse(init.body).title,'Investigate');
  return {number:9,title:'Investigate',html_url:'https://github.com/org/repo/issues/9'};
 });
 const result=await api.createIssue('oauth:alice','conn','org/repo','Investigate');
 assert.equal(result.number,9);
 assert.equal(grants[0].cap,'issues:write');
 await assert.rejects(()=>api.createIssue('oauth:bob','conn','org/repo','Investigate'),
  /CONNECTOR_NOT_FOUND/);
});
