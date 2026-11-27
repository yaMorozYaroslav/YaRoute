const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const {GithubAppService}=require('../dist/connectors/github-app.service');
const {ENABLED_PROVIDER_API_CAPABILITIES}=require('../dist/connectors/connectors.service');

const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({
  type:'pkcs8',format:'pem',
});
function config(){
 const names=['NYX_GITHUB_APP_ID','NYX_GITHUB_APP_PRIVATE_KEY_B64'];
 const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 process.env.NYX_GITHUB_APP_ID='55';
 process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64=Buffer.from(privateKey).toString('base64');
 return ()=>names.forEach(k=>old[k]===undefined?delete process.env[k]:process.env[k]=old[k]);
}
const connected={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'active',
 provider:'github',installationId:'321',externalAccountId:'owner',capabilities:['resources:read']};
test('new protection permission is user-selectable but not automatically enabled',()=>{
 assert.ok(ENABLED_PROVIDER_API_CAPABILITIES.github.includes('github:protection:read'));
});
test('refresh checks App installation identity and verified admin grant',async()=>{
 const restore=config(),oldFetch=global.fetch;
 const receipts=[];
 const connections={
   getOwned:async()=>connected,
   refreshGithubGrants:async (...args)=>{
     receipts.push(args);
     return {providerCapabilities:args[4],capabilities:connected.capabilities};
   },
 };
 try {
   global.fetch=async(url,init)=>{
     assert.match(url,/^https:\/\/api\.github\.com\/app\/installations\/321$/);
     assert.equal(init.method,'GET');
     return {ok:true,status:200,text:async()=>JSON.stringify({
       id:321,app_id:55,account:{login:'owner'},permissions:{
         administration:'read',contents:'write',actions:'read',
       },
     })};
   };
   const result=await new GithubAppService(connections)
     .refreshInstallationGrants('oauth:owner',connected.id);
   assert.deepEqual(receipts[0].slice(0,4),
     ['oauth:owner',connected.id,'321','owner']);
   assert.ok(result.providerCapabilities.includes('github:protection:read'));
   assert.deepEqual(result.capabilities,['resources:read']);
 } finally {global.fetch=oldFetch;restore();}
});
test('refresh refuses mismatched installation account and does not persist',async()=>{
 const restore=config(),oldFetch=global.fetch;
 let writes=0;
 try {
   global.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({
     id:321,app_id:55,account:{login:'different'},permissions:{administration:'write'},
   })});
   const connections={getOwned:async()=>connected,refreshGithubGrants:async()=>{writes++;}};
   await assert.rejects(()=>new GithubAppService(connections)
     .refreshInstallationGrants('oauth:owner',connected.id),
     /GITHUB_INSTALLATION_MISMATCH/);
   assert.equal(writes,0);
 } finally {global.fetch=oldFetch;restore();}
});
