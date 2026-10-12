const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const {GithubAppService}=require('../dist/connectors/github-app.service');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {CONNECTIONS_PANEL_HTML}=require('../dist/connectors/connections-panel');

const envKeys=['NYX_GITHUB_APP_ID','NYX_GITHUB_APP_PRIVATE_KEY_B64',
 'NYX_GITHUB_CLIENT_ID','NYX_GITHUB_CLIENT_SECRET','NYX_PUBLIC_URL'];
const privateKey=Buffer.from(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({
 type:'pkcs8',format:'pem'
}),'utf8').toString('base64');
function setup(){
 const original=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{
   NYX_GITHUB_APP_ID:'42',NYX_GITHUB_APP_PRIVATE_KEY_B64:privateKey,
   NYX_GITHUB_CLIENT_ID:'Iv1.autodiscovery',NYX_GITHUB_CLIENT_SECRET:'fake-test-only',
   NYX_PUBLIC_URL:'https://nestnyx.example',
 });
 return ()=>envKeys.forEach(k=>original[k]===undefined?delete process.env[k]:process.env[k]=original[k]);
}
const json=x=>({ok:true,status:200,text:async()=>JSON.stringify(x)});
function authorizedInstallation(id,login){
 return {id,app_id:42,account:{login},permissions:{metadata:'read',contents:'read'}};
}
async function tryDiscovery(installations,accountName){
 const restore=setup(),fetchBefore=global.fetch,calls=[];
 const activated=[];
 const connections={
   consumeGithubState:async()=>({ownerId:'oauth:test',connectionId:'conn1',installationId:'auto'}),
   getOwned:async(owner,id)=>{
     assert.equal(owner,'oauth:test');assert.equal(id,'conn1');
     return {provider:'github',status:'pending',displayName:accountName};
   },
   activateGithub:async(...args)=>{activated.push(args);return {status:'active',id:args[1]};},
 };
 try{
  global.fetch=async(url,options)=>{
   calls.push(url);
   if(url.endsWith('/login/oauth/access_token'))
     return json({access_token:'ghu_test_single_use_provider_token'});
   if(url.includes('/user/installations?per_page=100'))
     return json({total_count:installations.length,installations});
   const match=url.match(/\/app\/installations\/(\d+)$/);
   if(match){
     const item=installations.find(i=>String(i.id)===match[1]);
     if(!item)throw Error('Non-verified installation used');
     return json(item);
   }
   const access=url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
   if(access)return json({token:'ghs_test_repo_scoped_token'});
   if(url.endsWith('/installation/repositories'))
     return json({total_count:1,repositories:[{full_name:'org/repo'}]});
   throw Error('Unexpected request '+url);
  };
  let result,error;
  try{result=await new GithubAppService(connections).completeCallback('state','code-valid');}
  catch(e){error=e;}
  return {result,error,calls,activated};
 }finally{global.fetch=fetchBefore;restore();}
}

test('GitHub setup starts OAuth without manual installation ID',async()=>{
 const restore=setup();
 try{
   const row={id:'conn1',ownerId:'oauth:test',provider:'github',status:'pending'};
   const repo={get:async()=>row,list:async()=>[row],save:async()=>{}};
   const svc=new ConnectorsService({});
   svc.repository=repo;
   svc.registry=new ConnectorRegistry(repo);
   svc.consumeQuota=async()=>{};
   const queries=[];
   svc.pool={query:async(s,args)=>{queries.push({s,args});return{rows:[],rowCount:1};}};
   const consent=await svc.beginGithub('oauth:test','conn1');
   assert.match(consent.url,/^https:\/\/github.com\/login\/oauth\/authorize\?/);
   assert.equal(queries.find(x=>x.s.includes('INSERT INTO nyx_connector_link_states')).args.at(-1),'auto');
   assert.ok(!consent.url.includes('installation_id'));
 }finally{restore();}
});

test('automatically uses sole provider-confirmed NestNyx installation',async()=>{
 const r=await tryDiscovery([authorizedInstallation(987,'synthetic-test-user')],'Custom Label');
 assert.equal(r.error,undefined);
 assert.equal(r.result.status,'active');
 assert.deepEqual(r.activated[0].slice(0,4),['oauth:test','conn1','987','synthetic-test-user']);
 assert.ok(!JSON.stringify(r.activated).includes('ghu_'));
});
test('with multiple verified installations, match connection label to exact GitHub account',async()=>{
 const r=await tryDiscovery([authorizedInstallation(987,'other-user'),
   authorizedInstallation(321,'synthetic-test-user')],'synthetic-test-user');
 assert.equal(r.error,undefined);
 assert.equal(r.result.status,'active');
 assert.equal(r.activated[0][2],'321');
});
test('ambiguous installation choice never selects first account or grants access',async()=>{
 const r=await tryDiscovery([authorizedInstallation(987,'other-user'),
   authorizedInstallation(321,'synthetic-test-user')],'My projects');
 assert.match(String(r.error?.message),/GITHUB_INSTALLATION_CHOICE_REQUIRED/);
 assert.deepEqual(r.activated,[]);
 assert.ok(!r.calls.some(x=>x.includes('/app/installations/')));
});
test('no installed NestNyx app never activates pending connection',async()=>{
 const r=await tryDiscovery([{id:222,app_id:777,account:{login:'synthetic-test-user'}}],'synthetic-test-user');
 assert.match(String(r.error?.message),/GITHUB_APP_INSTALLATION_REQUIRED/);
 assert.deepEqual(r.activated,[]);
});
test('connection UI never asks for installation ID or sends caller-supplied installationId',()=>{
 const panel=CONNECTIONS_PANEL_HTML;
 assert.doesNotMatch(panel,/GitHub installation ID|Copy its installation ID|inst\.value\.trim\(\)/);
 assert.match(panel,/call\('nyx_connection_begin_github',\{id:c\.id\}\)/);
 assert.match(panel,/Installed GitHub Apps/);
 assert.match(panel,/GitHub account or organization you want to connect/);
 assert.match(panel,/oauth\.pathname!=='\/login\/oauth\/authorize'/);
});
