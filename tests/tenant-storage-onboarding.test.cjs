const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomBytes,createHash} = require('node:crypto');
const {TenantGoogleOAuthService} = require('../dist/connectors/tenant-google-oauth.service');
const {TenantMegaEnrollmentService} = require('../dist/connectors/tenant-mega-enrollment.service');
const {RcloneService} = require('../dist/storage/rclone.service');
const {SharedRootsService} = require('../dist/storage/shared-roots.service');

const id='11111111-2222-4333-8444-555555555555';
const owner='oauth:alice';
const vars=['NYX_PUBLIC_URL','NYX_GOOGLE_CLIENT_ID','NYX_GOOGLE_CLIENT_SECRET',
 'NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED','NYX_MULTIUSER_RCLONE_ENABLED',
 'RCLONE_CONFIG_B64','NYX_SHARED_ROOTS_JSON'];
function env(t) {
 const old=Object.fromEntries(vars.map(n=>[n,process.env[n]]));
 t.after(()=>{for(const[n,v] of Object.entries(old)) {
   if(v===undefined)delete process.env[n];else process.env[n]=v;
 }});
 process.env.NYX_PUBLIC_URL='https://nestnyx.example.com';
 process.env.NYX_GOOGLE_CLIENT_ID='some-google-client-id.apps.googleusercontent.com';
 process.env.NYX_GOOGLE_CLIENT_SECRET='dummy-client-secret';
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 process.env.NYX_MULTIUSER_RCLONE_ENABLED='true';
}
function connection(provider,root) {
 return {id,provider,ownerId:owner,status:'pending',externalAccountId:'pending',
 capabilities:['storage:list'],providerCapabilities:[],
 resources:[{kind:provider==='mega'?'mega-root':'drive',id:root,
   capabilities:['storage:list']}]};
}
function stores(c) {
 const records=[]; const staged=[];const confirmed=[];
 const connectors={
   getOwned:async(o,i)=>{if(o!==owner||i!==id)throw Error('DENIED');return c;},
   confirmStorageProvider:async(...xs)=>confirmed.push(xs),
 };
 const storage={
   stageCredential:async(...xs)=>staged.push(xs),
   probePending:async()=> 'verified',
 };
 return {connectors,storage,records,staged,confirmed};
}

test('public tenants do not load or run the legacy process-wide rclone config',async t=>{
 env(t);
 process.env.RCLONE_CONFIG_B64=Buffer.from('[legacy]\ntype = drive\n').toString('base64');
 delete process.env.NYX_SHARED_ROOTS_JSON;
 const old=new RcloneService();
 assert.throws(()=>old.onModuleInit(),/PUBLIC_STORAGE_PRIVATE_CONFIG_PRESENT/);
 await assert.rejects(()=>old.run(['listremotes']),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
 assert.deepEqual(new SharedRootsService().listAreas(),[]);
});

test('Google OAuth begins with one-use state, PKCE, offline readonly scope and selected folder',async t=>{
 env(t);
 const c=connection('google-drive','folder123');
 const {connectors,storage,records}=stores(c);
 const svc=new TenantGoogleOAuthService(connectors,storage);
 svc.key=randomBytes(32);
 svc.pool={query:async(sql,params)=>{records.push({sql,params});return {rowCount:1}}};
 const result=await svc.begin(owner,id,'folder123');
 const url=new URL(result.url);
 assert.equal(url.hostname,'accounts.google.com');
 assert.equal(url.searchParams.get('access_type'),'offline');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.ok(url.searchParams.get('scope').includes('drive.readonly'));
 assert.ok(url.searchParams.get('code_challenge'));
 assert.ok(url.searchParams.get('state'));
 assert.equal(records[1].params[1],owner);
 assert.equal(records[1].params[3],'folder123');
 assert.equal(JSON.stringify(result).includes('client-secret'),false);
 await assert.rejects(()=>svc.begin(owner,id,'different'),/ROOT_NOT_SELECTED/);
});

test('Google callback consumes state and stages provider-bound credential without exposing tokens',async t=>{
 env(t);
 const c=connection('google-drive','folder123');
 const {connectors,storage,staged,confirmed}=stores(c);
 const svc=new TenantGoogleOAuthService(connectors,storage);
 svc.key=randomBytes(32);
 let stateRow;
 svc.pool={query:async(sql,params)=>{
   if(sql.startsWith('INSERT')) {
     stateRow={owner_id:params[1],connection_id:params[2],folder_id:params[3],
        encrypted_verifier:params[4]};
     return {rowCount:1};
   }
   if(sql.startsWith('DELETE')&&sql.includes('RETURNING')) {
     const expect=createHash('sha256').update(oauthState).digest('hex');
     assert.equal(params[0],expect);
     return {rowCount:1,rows:[stateRow]};
   }
   return {rowCount:1};
 }};
 const {url}=await svc.begin(owner,id,'folder123');
 const oauthState=new URL(url).searchParams.get('state');
 const original=global.fetch;
 t.after(()=>{global.fetch=original;});
 let calls=0;
 global.fetch=async(url)=> {
   calls++;
   if(String(url).includes('/token'))return {
     ok:true,text:async()=>JSON.stringify({
      access_token:'private_access_token',refresh_token:'private_refresh_token',
      expires_in:3600,token_type:'Bearer',
      scope:'openid email https://www.googleapis.com/auth/drive.readonly',
     })};
   return {ok:true,text:async()=>JSON.stringify({sub:'provider-account-42'})};
 };
 const outcome=await svc.complete(oauthState,'google-oauth-code');
 assert.equal(outcome.status,'pending_read_probe');
 assert.equal(calls,2);
 assert.equal(staged.length,1);
 assert.equal(staged[0][0],owner);
 assert.equal(staged[0][1],id);
 assert.equal(staged[0][2].rootFolderId,'folder123');
 assert.equal(staged[0][2].provider,'google-drive');
 assert.equal(confirmed.length,1);
 assert.equal(confirmed[0][3],'provider-account-42');
 assert.equal(JSON.stringify(outcome).includes('private_'),false);
});

test('MEGA sign-in uses one-time HTTPS form link and requires a successful probe',async t=>{
 env(t);
 const c=connection('mega','MEGA_ROOT');
 const {connectors,storage,staged,confirmed}=stores(c);
 const svc=new TenantMegaEnrollmentService(connectors,storage);
 let saved;
 svc.pool={query:async(sql,params)=>{
   if(sql.startsWith('INSERT'))saved={owner_id:params[1],connection_id:params[2],root_path:params[3]};
   if(sql.includes('RETURNING'))return {rowCount:1,rows:[saved]};
   return {rowCount:1};
 }};
 svc.obscure=async()=> 'test-obscured-password';
 const {url}=await svc.begin(owner,id,'MEGA_ROOT');
 assert.equal(new URL(url).host,'nestnyx.example.com');
 const state=new URL(url).searchParams.get('state');
 const result=await svc.complete(state,'tester@example.com','not-an-actual-password');
 assert.equal(result.status,'pending_activation');
 assert.equal(staged.length,1);
 assert.equal(staged[0][2].provider,'mega');
 assert.equal(confirmed[0][3],'tester@example.com');
 const bad=stores(c);
 bad.storage.probePending=async()=> 'failed';
 const other=new TenantMegaEnrollmentService(bad.connectors,bad.storage);
 other.pool={query:async(sql)=>sql.includes('RETURNING')
   ?{rowCount:1,rows:[saved]}:{rowCount:1}};
 other.obscure=async()=> 'test-obscured-password';
 await assert.rejects(()=>other.complete(state,'tester@example.com','wrong'),/READ_PROBE_FAILED/);
 assert.equal(bad.confirmed.length,0);
});
