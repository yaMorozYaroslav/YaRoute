const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const owner='oauth:google-oauth2|123456789012345678';
const id='a7c86541-298c-4bbe-8123-5d61bc220e11';
const profile={provider:'mega',user:'fixture_user',obscuredPassword:'fixture_obscured',
 verifiedRoot:'MEGA_ROOT'};
function fixture(withProof=true){
 const records=[];
 const svc=new TenantRcloneService({getOwned:async(actor,key)=>{
  if(actor!==owner||key!==id)throw Error('FOREIGN_TENANT');
  return {id,ownerId:owner,provider:'mega',status:'pending',
   capabilities:['storage:list'],providerCapabilities:[],
   resources:[{kind:'mega-root',id:'MEGA_ROOT',capabilities:['storage:list']}]};
 }});
 svc.encryptionKey=Buffer.alloc(32,19);
 const encrypted=svc.seal(owner,id,profile);
 svc.pool={connect:async()=>({
  query:async(sql,args=[])=>{
   records.push({sql,args});
   if(sql.startsWith('SELECT provider,status'))return {rowCount:1,rows:[{
    provider:'mega',status:'pending',external_account_id:'pending',
    capabilities:['storage:list'],provider_capabilities:[],
    resources:[{kind:'mega-root',id:'MEGA_ROOT',capabilities:['storage:list']}]}
   ]};
   if(sql.startsWith('SELECT provider,namespace,external_id'))return withProof?
    {rowCount:1,rows:[{provider:'mega',namespace:'mega:fixture',
      external_id:'fixture_user'}]}:{rowCount:0,rows:[]};
   if(sql.startsWith('SELECT provider,encrypted_profile'))return {
    rowCount:1,rows:[{provider:'mega',encrypted_profile:encrypted}]};
   if(sql.startsWith('SELECT connection_id'))return {rowCount:0,rows:[]};
   if(sql.startsWith('UPDATE'))return {rowCount:1,rows:[{id}]};
   return {rowCount:0,rows:[]};
  },release:()=>{},
 })};
 return {svc,records};
}
test('verified import activates read-only metadata and ciphertext transactionally',async()=>{
 const {svc,records}=fixture();
 const result=await svc.activateImportedReadOnly(owner,id);
 assert.equal(result.status,'active');
 assert.deepEqual(result.capabilities,['storage:list']);
 assert.equal(records.filter(q=>q.sql==='BEGIN').length,1);
 assert.equal(records.filter(q=>q.sql==='COMMIT').length,1);
 assert.equal(records.filter(q=>q.sql==='ROLLBACK').length,0);
 const updates=records.filter(q=>q.sql.startsWith('UPDATE'));
 assert.equal(updates.length,2);
 assert.ok(updates[0].sql.includes("provider_capabilities='[\"storage:list\"]'"));
 assert.ok(updates[0].sql.includes("status='active'"));
 assert.ok(updates[1].sql.includes("state='active'"));
 assert.ok(records.every(q=>!JSON.stringify(q.args).includes('fixture_obscured')));
});
test('without verified provider identity, activation rolls back with no writes',async()=>{
 const {svc,records}=fixture(false);
 await assert.rejects(svc.activateImportedReadOnly(owner,id),/ATTESTATION_REQUIRED/);
 assert.equal(records.filter(q=>q.sql==='ROLLBACK').length,1);
 assert.equal(records.some(q=>q.sql.startsWith('UPDATE')),false);
});
test('another signed owner cannot reach the tenant vault transaction',async()=>{
 const {svc,records}=fixture();
 await assert.rejects(svc.activateImportedReadOnly('oauth:google-oauth2|111111111111111',id),
   /CONNECTION_FORBIDDEN/);
 assert.equal(records.length,0);
});
