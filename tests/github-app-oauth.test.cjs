const { test }=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const {GithubAppService}=require('../dist/connectors/github-app.service');

function resp(value,status=200) {
 return {ok:status>=200 && status<300,
   text:async()=>JSON.stringify(value)};
}
test('GitHub OAuth only links the exact verified installation and stores no user token',async t=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const old={
  NYX_GITHUB_APP_ID:process.env.NYX_GITHUB_APP_ID,
  NYX_GITHUB_APP_PRIVATE_KEY_B64:process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64,
  NYX_GITHUB_CLIENT_ID:process.env.NYX_GITHUB_CLIENT_ID,
  NYX_GITHUB_CLIENT_SECRET:process.env.NYX_GITHUB_CLIENT_SECRET,
  NYX_PUBLIC_URL:process.env.NYX_PUBLIC_URL,
 };
 const oldFetch=global.fetch;
 t.after(()=>{
  global.fetch=oldFetch;
  for(const [key,value] of Object.entries(old)){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 });
 process.env.NYX_GITHUB_APP_ID='123';
 process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64=Buffer.from(
  privateKey.export({type:'pkcs8',format:'pem'})).toString('base64');
 process.env.NYX_GITHUB_CLIENT_ID='Iv1.example';
 process.env.NYX_GITHUB_CLIENT_SECRET='example-test-secret';
 process.env.NYX_PUBLIC_URL='https://app.example.test';
 const captured=[];
 const activated=[];
 global.fetch=async (url,init)=>{
  captured.push({url,init});
  if(url==='https://github.com/login/oauth/access_token'){
   assert.equal(init.method,'POST');
   return resp({access_token:'ghu_example_temporary_user_token'});
  }
  if(url==='https://api.github.com/user/installations?per_page=100')return resp({
    total_count:1,installations:[{id:456,app_id:123,account:{login:'project-org'}}]
  });
  if(url==='https://api.github.com/app/installations/456')return resp({
    id:456,app_id:123,account:{login:'project-org'},
    permissions:{actions:'read',contents:'read',issues:'read',pull_requests:'read'}
  });
  if(url==='https://api.github.com/app/installations/456/access_tokens'){
   const body=JSON.parse(init.body);
   assert.deepEqual(body.permissions,{metadata:'read'});
   return resp({token:'ghs_example_metadata_token'});
  }
  if(url==='https://api.github.com/installation/repositories')return resp({
   total_count:1,repositories:[{full_name:'project-org/code'}]
  });
  throw new Error('Unrecognized GitHub API request '+url);
 };
 const links={
  consumeGithubState:async state=>{
   assert.equal(state,'random-signed-state');
   return {ownerId:'oauth:alice',connectionId:'conn-1',installationId:'456'};
  },
  activateGithub:async(...args)=>{activated.push(args);return {status:'active'};}
 };
 const service=new GithubAppService(links);
 const result=await service.completeCallback('random-signed-state','temporary-oauth-code');
 assert.equal(result.status,'active');
 assert.deepEqual(activated[0].slice(0,4),['oauth:alice','conn-1','456','project-org']);
 assert.ok(activated[0][4].includes('ci:read'));
 assert.ok(activated[0][4].includes('releases:read'));
 assert.deepEqual(activated[0][5],['project-org/code']);
 assert.equal(captured.some(x=>x.init.method==='PATCH'||x.init.method==='DELETE'),false);
 assert.equal(JSON.stringify(activated).includes('ghu_example_temporary_user_token'),false);
});

test('GitHub installation token cannot request write privileges',async t=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const oldEnv={...process.env};
 const originalFetch=global.fetch;
 t.after(()=>{
  global.fetch=originalFetch;
  for(const name of ['NYX_GITHUB_APP_ID','NYX_GITHUB_APP_PRIVATE_KEY_B64'])
   if(oldEnv[name]===undefined)delete process.env[name];else process.env[name]=oldEnv[name];
 });
 process.env.NYX_GITHUB_APP_ID='123';
 process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64=Buffer.from(
  privateKey.export({type:'pkcs8',format:'pem'})).toString('base64');
 const saved=[];
 global.fetch=async (url,init)=>{
  assert.match(url,/^https:\/\/api\.github\.com\/app\/installations\/456\/access_tokens$/);
  const body=JSON.parse(init.body);saved.push(body);
  assert.deepEqual(body.repositories,['code']);
  assert.deepEqual(body.permissions,{metadata:'read',contents:'read'});
  return resp({token:'ghs_scoped_installation_token'});
 };
 const fakeRegistry={
  requireResource:async (_owner,_id,_cap,rule)=>{
   assert.equal(rule.branch,'main');
   assert.equal(rule.path,'docs/readme.md');
   return {provider:'github',installationId:'456'};
  },
 };
 const svc=new GithubAppService({registryPolicy:()=>fakeRegistry});
 const token=await svc.tokenFor('oauth:alice','conn-1','456','project-org/code','resources:read',
  {branch:'main',path:'docs/readme.md'});
 assert.equal(token,'ghs_scoped_installation_token');
 assert.equal(saved.length,1);
 assert.equal(JSON.stringify(saved).includes('write'),false);
});
