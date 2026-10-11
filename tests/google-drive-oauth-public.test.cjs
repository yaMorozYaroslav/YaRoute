const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {GoogleDriveOAuthService}=require('../dist/connectors/google-drive-oauth');
const {revokeGoogleDriveProfile}=require('../dist/connectors/google-drive-oauth-config');
const id='123e4567-e89b-42d3-a456-426614174000';
const envKeys=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED','NYX_PUBLIC_URL',
 'NYX_GOOGLE_CLIENT_ID','NYX_GOOGLE_CLIENT_SECRET','NYX_RCLONE_VAULT_ENABLED'];
function config(t){
 const old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const [k,v] of Object.entries(old))v===undefined?
 delete process.env[k]:process.env[k]=v});
 Object.assign(process.env,{NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
 NYX_PUBLIC_URL:'https://nestnyx.example',NYX_GOOGLE_CLIENT_ID:'public-oauth-id',
 NYX_GOOGLE_CLIENT_SECRET:'test-only-example',NYX_RCLONE_VAULT_ENABLED:'true'});
}
function fixture(){
 const row={id,ownerId:'oauth:alice',provider:'google-drive',
   displayName:'Alice Drive',externalAccountId:'alice_drive',status:'pending',
   capabilities:[],providerCapabilities:[],resources:[]};
 const states=new Map();const writes=[];let scopes=0;
 const vault={isEnabled:()=>true,
   load:async()=>undefined,store:async(...args)=>{writes.push(args);return{stored:true};},
   revoke:async()=>{}};
 const storage={testRcloneConnection:async()=>{scopes++;throw Error('must not use shared Rclone');},
   testIsolatedRcloneConnection:async()=>({schema:'nyx.storage.rclone.probe.v1',status:'reachable'})};
 const service=new ConnectorsService(storage,vault);
 service.repository={get:async key=>key===id?row:null,list:async owner=>owner===row.ownerId?[row]:[],
   save:async()=>{}};
 service.registry={list:async owner=>owner===row.ownerId?[row]:[]};
 service.pool={query:async(sql,args)=>{
   if(sql.includes('INSERT INTO nyx_google_drive_oauth_states')){
     states.set(args[0],{owner_id:args[1],connection_id:args[2],code_verifier:args[3]});
     return{rowCount:1,rows:[]};
   }
   if(sql.includes('DELETE FROM nyx_google_drive_oauth_states')){
     const state=states.get(args[0]);states.delete(args[0]);
     return state?{rowCount:1,rows:[state]}:{rowCount:0,rows:[]};
   }
   if(sql.includes("UPDATE nyx_connector_connections SET status='active'")){
     row.status='active';return{rowCount:1,rows:[{id}]};
   }
   throw Error('Unexpected SQL operation');
 }};
 return {service,row,states,writes,vault,getSharedCallCount:()=>scopes};
}
test('public owner can initiate PKCE Google read-only OAuth without leaking verifier',async t=>{
 config(t);
 const {service,states}=fixture();
 const v=await service.beginGoogleDrive('oauth:alice',id);
 const url=new URL(v.authorizationUrl);
 assert.equal(url.origin,'https://accounts.google.com');
 assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.readonly');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.ok(url.searchParams.get('code_challenge'));
 assert.equal(states.size,1);
 const stored=[...states.values()][0];
 assert.equal(stored.owner_id,'oauth:alice');
 assert.ok(!v.authorizationUrl.includes(stored.code_verifier));
 await assert.rejects(()=>service.beginGoogleDrive('oauth:bob',id),/CONNECTOR_NOT_FOUND/);
});
test('one-time state exchange encrypts profile and marks only owned Drive active',async t=>{
 config(t);const {service,row,writes}=fixture();
 const begin=await service.beginGoogleDrive('oauth:alice',id);
 const state=new URL(begin.authorizationUrl).searchParams.get('state');
 const old=global.fetch;t.after(()=>global.fetch=old);
 let requests=0;
 global.fetch=async(url,opt)=>{
   requests++;
   assert.equal(url,'https://oauth2.googleapis.com/token');
   assert.equal(opt.method,'POST');
   const fields=new URLSearchParams(opt.body);
   assert.equal(fields.get('code_verifier').length>40,true);
   assert.equal(fields.get('redirect_uri'),'https://nestnyx.example/connect/google/callback');
   return{ok:true,text:async()=>JSON.stringify({access_token:'TEST_ACCESS',
     refresh_token:'TEST_REFRESH',token_type:'Bearer',expires_in:3600,
     scope:'https://www.googleapis.com/auth/drive.readonly'})};
 };
 const complete=new GoogleDriveOAuthService(service,service.vault);
 const result=await complete.complete(state,'test-code');
 assert.equal(result.connected,true);
 assert.equal(row.status,'active');
 assert.equal(writes.length,1);
 assert.deepEqual(writes[0].slice(0,4),['oauth:alice',id,'google-drive','alice_drive']);
 assert.ok(writes[0][4].includes('type = drive'));
 assert.ok(writes[0][4].includes('scope = drive.readonly'));
 await assert.rejects(()=>complete.complete(state,'test-code'),/GOOGLE_OAUTH_STATE_EXPIRED/);
 assert.equal(requests,1);
});
test('missing refresh token never grants active Drive and does not write vault',async t=>{
 config(t);const {service,row,writes}=fixture();
 const begin=await service.beginGoogleDrive('oauth:alice',id);
 const state=new URL(begin.authorizationUrl).searchParams.get('state');
 const old=global.fetch;t.after(()=>global.fetch=old);
 global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({
   access_token:'TEST_ACCESS',token_type:'Bearer',expires_in:3600})});
 const oauth=new GoogleDriveOAuthService(service,service.vault);
 await assert.rejects(()=>oauth.complete(state,'test-code'),/GOOGLE_OAUTH_REFRESH_TOKEN_REQUIRED/);
 assert.equal(row.status,'pending');assert.equal(writes.length,0);
});
test('Google provider revocation posts refresh token to fixed provider endpoint',async t=>{
 const old=global.fetch;t.after(()=>global.fetch=old);
 global.fetch=async(url,opts)=>{
   assert.equal(url,'https://oauth2.googleapis.com/revoke');
   assert.equal(opts.method,'POST');
   assert.equal(new URLSearchParams(opts.body).get('token'),'TEST_REFRESH');
   return{ok:true};
 };
 assert.equal(await revokeGoogleDriveProfile('[one]\ntype = drive\ntoken = {"refresh_token":"TEST_REFRESH"}\n'),true);
 assert.equal(await revokeGoogleDriveProfile('[one]\ntype = drive\n'),false);
});
