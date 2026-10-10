const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const {GithubAppService}=require('../dist/connectors/github-app.service');
const {CONNECTIONS_PANEL_HTML,CONNECTIONS_PANEL_URI}=require('../dist/connectors/connections-panel');

const key=Buffer.from(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({
 type:'pkcs8',format:'pem',
}),'utf8').toString('base64');
const backupKeys=['NYX_GITHUB_APP_ID','NYX_GITHUB_APP_PRIVATE_KEY_B64',
 'NYX_GITHUB_CLIENT_ID','NYX_GITHUB_CLIENT_SECRET','NYX_PUBLIC_URL'];
function configured(){
 const previous=Object.fromEntries(backupKeys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{
  NYX_GITHUB_APP_ID:'42',NYX_GITHUB_APP_PRIVATE_KEY_B64:key,
  NYX_GITHUB_CLIENT_ID:'Iv1.testing',NYX_GITHUB_CLIENT_SECRET:'mock-oauth-secret',
  NYX_PUBLIC_URL:'https://nestnyx.example',
 });
 return ()=>backupKeys.forEach(k=>previous[k]===undefined?delete process.env[k]:process.env[k]=previous[k]);
}
function json(data){return{ok:true,status:200,text:async()=>JSON.stringify(data)};}
test('MCP Apps panel has local operations and no external credential forms',()=>{
 assert.match(CONNECTIONS_PANEL_URI,/^ui:\/\/nestnyx\//);
 assert.match(CONNECTIONS_PANEL_HTML,/ui\/initialize/);
 assert.match(CONNECTIONS_PANEL_HTML,/tools\/call/);
 assert.match(CONNECTIONS_PANEL_HTML,/nyx_connection_begin_github/);
 assert.doesNotMatch(CONNECTIONS_PANEL_HTML,/nyx_connection_verify_heroku/);
 assert.doesNotMatch(CONNECTIONS_PANEL_HTML,/value="heroku"/);
 assert.match(CONNECTIONS_PANEL_URI,/\/v2\.html$/);
 assert.doesNotMatch(CONNECTIONS_PANEL_HTML,/type="password"/);
 assert.doesNotMatch(CONNECTIONS_PANEL_HTML,/https:\/\/cdn\./);
 const scriptStart=CONNECTIONS_PANEL_HTML.indexOf('<script>')+8;
 const scriptEnd=CONNECTIONS_PANEL_HTML.indexOf('</script>',scriptStart);
 const panelScript=CONNECTIONS_PANEL_HTML.slice(scriptStart,scriptEnd);
 assert.ok(panelScript);
 assert.doesNotThrow(()=>new (require('node:vm').Script)(panelScript));
});
test('GitHub OAuth linking verifies the user-accessible installation and never stores user token',async()=>{
 const restore=configured();const oldFetch=global.fetch;
 const called=[];
 const connections={
  consumeGithubState:async state=>{
    assert.equal(state,'valid-onetime-state');return{ownerId:'oauth:user',connectionId:'pending-id',installationId:'987'};},
  activateGithub:async(...args)=>{
    assert.deepEqual(args.slice(0,4),['oauth:user','pending-id','987','research-org']);
    assert.ok(args[4].includes('ci:read'));assert.ok(args[4].includes('issues:read'));
    assert.equal(args[4].includes('issues:write'),true);
    assert.equal(args[4].includes('contents:write'),false);
    assert.equal(args[4].includes('pulls:write'),false);
    assert.deepEqual(args[5],['research-org/project']);
    assert.equal(JSON.stringify(args).includes('ghu_'),false);
    return{id:'pending-id',status:'active'};
  },
 };
 try{
  global.fetch=async(url,options)=>{
    called.push({url,options});
    if(url.includes('/login/oauth/access_token'))return json({access_token:'ghu_mock_user_token_long'});
    if(url.includes('/user/installations?'))return json({total_count:1,installations:[{
     id:987,app_id:42,account:{login:'research-org'},
    }]});
    if(url.endsWith('/app/installations/987'))return json({
     id:987,app_id:42,account:{login:'research-org'},
     permissions:{metadata:'read',actions:'read',issues:'write'},
    });
    if(url.endsWith('/app/installations/987/access_tokens'))return json({
     token:'ghs_mock_install_token_long',
    });
    if(url.endsWith('/installation/repositories'))return json({
     total_count:1,repositories:[{full_name:'research-org/project'}],
    });
    throw Error('unexpected host/path '+url);
  };
  const result=await new GithubAppService(connections).completeCallback('valid-onetime-state','code-valid');
  assert.equal(result.status,'active');
  assert.equal(called[0].options.method,'POST');
  assert.equal(called[0].url,'https://github.com/login/oauth/access_token');
  assert.equal(called.filter(c=>c.url.includes('/app/installations/987/access_tokens')).length,1);
 }finally{global.fetch=oldFetch;restore();}
});
test('GitHub OAuth linking rejects installations not accessible to user',async()=>{
 const restore=configured();const oldFetch=global.fetch;
 const connections={consumeGithubState:async()=>({ownerId:'oauth:alice',
   connectionId:'pending-id',installationId:'987'}),
  activateGithub:async()=>{throw Error('should not activate');}};
 try{
  global.fetch=async(url)=>{
   if(url.includes('/login/oauth/access_token'))return json({access_token:'ghu_mock_user_token_long'});
   if(url.includes('/user/installations'))return json({total_count:0,installations:[]});
   throw Error('other request must not be made');
  };
  await assert.rejects(()=>new GithubAppService(connections).completeCallback('state','code-valid'),
    /GITHUB_INSTALLATION_NOT_OWNED/);
 }finally{global.fetch=oldFetch;restore();}
});
test('GitHub App token for a repo is read-only, repo-specific and short lived',async()=>{
 const restore=configured();const oldFetch=global.fetch;
 try{
  let request;
  global.fetch=async(url,options)=>{
   request={url,options};
   return json({token:'ghs_mock_install_token_long'});
  };
  const connections={
   registryPolicy:()=>({requireResource:async(owner,id,cap,resource)=>{
    assert.deepEqual([owner,id,cap,resource],
      ['oauth:alice','conn-1','ci:read',{kind:'repository',id:'team/repo'}]);
    return{provider:'github',installationId:'987'};
   }}),
  };
  const result=await new GithubAppService(connections)
    .tokenFor('oauth:alice','conn-1','987','team/repo','ci:read');
  assert.equal(result,'ghs_mock_install_token_long');
  assert.match(request.url,/^https:\/\/api\.github\.com\/app\/installations\/987\/access_tokens$/);
  const body=JSON.parse(request.options.body);
  assert.deepEqual(body.repositories,['repo']);
  assert.deepEqual(body.permissions,{metadata:'read',actions:'read'});
  assert.ok(!JSON.stringify(body).includes('write'));
 }finally{global.fetch=oldFetch;restore();}
});
