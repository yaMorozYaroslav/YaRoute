const {test}=require('node:test');
const assert=require('node:assert/strict');
const {verifyImportedGoogleIdentity}=require('../dist/connectors/imported-google-identity');
function profile(overrides={}){
 return {provider:'google-drive',rootFolderId:'root',accountRoot:true,
  token:JSON.stringify({access_token:'fixture_valid_access'}),...overrides};
}
function mockFetch(pathToObject,calls){
 return async (url,options)=>{
  calls.push({url,options});
  const body=pathToObject.find(([fragment])=>url.includes(fragment))?.[1];
  return {ok:!!body,text:async()=>JSON.stringify(body||{})};
 };
}
test('imported My Drive identity comes from provider about user permissionId, not config alias',async()=>{
 const calls=[];
 const actual=await verifyImportedGoogleIdentity(profile(),mockFetch([
  ['/drive/v3/about?',{user:{permissionId:'0123456789'}}]],calls));
 assert.deepEqual(actual,{accountId:'0123456789',driveId:null});
 assert.equal(calls.length,1);
 assert.equal(calls[0].options.redirect,'error');
 assert.match(calls[0].url,/^https:\/\/www\.googleapis\.com\/drive\/v3\/about/);
});
test('selected Shared Drive requires provider attestation of exact Drive ID',async()=>{
 const calls=[];
 const result=await verifyImportedGoogleIdentity(profile({
  teamDriveId:'0A_shared_fixture_01'}),mockFetch([
  ['/drive/v3/about?',{user:{permissionId:'account_1'}}],
  ['/drive/v3/drives/',{id:'0A_shared_fixture_01'}]],calls));
 assert.deepEqual(result,{accountId:'account_1',driveId:'0A_shared_fixture_01'});
 assert.equal(calls.length,2);
 await assert.rejects(verifyImportedGoogleIdentity(profile({
  teamDriveId:'0A_shared_fixture_01'}),mockFetch([
   ['/drive/v3/about?',{user:{permissionId:'account_1'}}],
   ['/drive/v3/drives/',{id:'ANOTHER_DRIVE'}]],[])),
  /SHARED_DRIVE_INVALID/);
});
test('explicit imported folder is checked for physical Drive and trashed status',async()=>{
 const calls=[];
 const attested=await verifyImportedGoogleIdentity(profile({
  rootFolderId:'folder_3',accountRoot:false
 }),mockFetch([
  ['/drive/v3/about?',{user:{permissionId:'account_3'}}],
  ['/drive/v3/files/',{id:'folder_3',mimeType:'application/vnd.google-apps.folder',
    driveId:'0A_shared_fixture_03',trashed:false}]],calls));
 assert.equal(attested.driveId,'0A_shared_fixture_03');
 assert.equal(calls.length,2);
 await assert.rejects(verifyImportedGoogleIdentity(profile({
  rootFolderId:'folder_3',accountRoot:false
 }),mockFetch([
  ['/drive/v3/about?',{user:{permissionId:'account_3'}}],
  ['/drive/v3/files/',{id:'folder_3',mimeType:'application/vnd.google-apps.folder',
    trashed:true}]],[])),/ROOT_INVALID/);
});
test('malformed provider identities and redirects fail closed; no arbitrary hostname',async()=>{
 const broken=profile({token:JSON.stringify({access_token:'short'})});
 await assert.rejects(verifyImportedGoogleIdentity(broken),/TOKEN_INVALID/);
 await assert.rejects(verifyImportedGoogleIdentity(profile(),async()=>({
   ok:false,text:async()=>'{error}'})),/IDENTITY_UNAVAILABLE/);
 await assert.rejects(verifyImportedGoogleIdentity(profile(),async()=>({
   ok:true,text:async()=>JSON.stringify({user:{permissionId:'bad/subject'}})})),
   /IDENTITY_INVALID/);
});
