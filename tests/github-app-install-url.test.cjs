const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {generateKeyPairSync}=require('node:crypto');
const {githubInstallationUrl}=require('../dist/connectors/github-app.service');
const {CONNECTIONS_PANEL_HTML,CONNECTIONS_PANEL_URI}=require('../dist/connectors/connections-panel');

const key=Buffer.from(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({
 type:'pkcs8',format:'pem'
}),'utf8').toString('base64');
function setup(){
 const original={
  NYX_GITHUB_APP_ID:process.env.NYX_GITHUB_APP_ID,
  NYX_GITHUB_APP_PRIVATE_KEY_B64:process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64,
 };
 process.env.NYX_GITHUB_APP_ID='42';
 process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64=key;
 return()=>Object.entries(original).forEach(([k,v])=>
   v===undefined?delete process.env[k]:process.env[k]=v);
}
const json=data=>({ok:true,text:async()=>JSON.stringify(data)});

test('only server-verified GitHub App metadata produces an install URL; no client slug',async()=>{
 const restore=setup(),previous=global.fetch;const calls=[];
 try{
  global.fetch=async(url,opts)=>{
   calls.push({url,opts});
   return json({id:42,slug:'nestnyx-custom-app'});
  };
  const result=await githubInstallationUrl();
  assert.deepEqual(result,{provider:'github',
   url:'https://github.com/apps/nestnyx-custom-app/installations/new'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.github.com/app');
  assert.equal(calls[0].opts.method,'GET');
  assert.match(calls[0].opts.headers.Authorization,/^Bearer [A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE KEY|Bearer|github_client_secret/);
 }finally{global.fetch=previous;restore();}
});

test('mismatched app ID, malformed slug, and GitHub errors reject the installation link',async()=>{
 const restore=setup(),previous=global.fetch;
 try{
  for(const app of [{id:99,slug:'nestnyx-custom-app'},
    {id:42,slug:'../evil'}, {id:42,slug:'app?inject=true'}, 
    {id:42,slug:'a.example.com'}, {id:42,slug:''}]){
    global.fetch=async()=>json(app);
    await assert.rejects(githubInstallationUrl(),/GITHUB_APP_INSTALLATION_URL_UNAVAILABLE/);
  }
  global.fetch=async()=>({ok:false,text:async()=>'not authorized'});
  await assert.rejects(githubInstallationUrl(),/GITHUB_API_UNAVAILABLE/);
 }finally{global.fetch=previous;restore();}
});

test('new GitHub install tool is owner-scoped and never displays credentials',()=>{
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 const start=mcp.indexOf("server.registerTool('nyx_connection_github_install_url'");
 const end=mcp.indexOf("server.registerTool('nyx_connection_begin_github'",start);
 assert.ok(start>=0 && end>start);
 const tool=mcp.slice(start,end);
 assert.match(tool,/this\.connections\.getOwned\(this\.connectorOwner\(\),id\)/);
 assert.match(tool,/connection\.provider!=='github'\|\|connection\.status!=='pending'/);
 assert.match(tool,/githubInstallationUrl\(\)/);
 assert.match(tool,/readOnlyHint:true/);
 assert.match(tool,/visibility:\['app'\]/);
 assert.doesNotMatch(tool,/installationId:/);
 assert.match(CONNECTIONS_PANEL_URI,/v9\.html/);
 assert.match(CONNECTIONS_PANEL_HTML,/Install NestNyx App/);
 assert.match(CONNECTIONS_PANEL_HTML,/call\('nyx_connection_github_install_url',\{id:c\.id\}\)/);
 assert.match(CONNECTIONS_PANEL_HTML,/install\.hostname!=='github\.com'/);
 assert.match(CONNECTIONS_PANEL_HTML,/Install NestNyx on selected repositories/);
 assert.doesNotMatch(CONNECTIONS_PANEL_HTML,/GitHub installation ID|Copy its installation ID/);
});
