const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const owner='oauth:alice',id='11111111-2222-4333-8444-555555555555';
const base={provider:'mega',user:['fixture','example.invalid'].join('@'),obscuredPassword:'test-only'};
function fixture(root='Selected') {
 const connection={ownerId:owner,id,provider:'mega',status:'active',
  capabilities:['storage:list'],providerCapabilities:['storage:list'],
  resources:[{kind:'mega-root',id:root,capabilities:['storage:list']}]};
 const service=new TenantRcloneService({
  getOwned:async actor=>{if(actor!==owner)throw Error('DENIED');return connection;},
  registryPolicy:()=>({require:async()=>connection,requireResource:async()=>connection}),
 });
 service.encryptionKey=Buffer.alloc(32,17);
 const queries=[];
 const candidate={provider:'mega',profile:{...base},packed:'initial-ciphertext'};
 service.profile=async()=>candidate;
 service.probe=async()=> 'verified';
 service.pool={query:async(sql,params)=>{queries.push({sql,params});return {rowCount:1};}};
 return {service,connection,queries,candidate};
}
test('successful MEGA read seals the exact root inside owner-bound credential',async()=>{
 const {service,queries}=fixture();
 assert.equal(await service.probePending(owner,id,'Selected'),'verified');
 const saved=service.open(owner,id,'mega',queries[0].params[3]);
 assert.equal(saved.verifiedRoot,'Selected');
 assert.throws(()=>service.open('oauth:bob',id,'mega',queries[0].params[3]));
});
test('changed grant cannot activate previously verified MEGA root',async()=>{
 const {service,connection,candidate}=fixture();
 candidate.profile={...base,verifiedRoot:'Selected'};
 connection.resources[0].id='Different';
 service.pool.connect=async()=>{throw Error('MUST_NOT_OPEN_TRANSACTION');};
 await assert.rejects(()=>service.activate(owner,id),/VERIFIED_ROOT_CHANGED/);
});
test('active credential cannot follow a changed grant or missing legacy root proof',async()=>{
 for(const verifiedRoot of ['Other',undefined]) {
  const {service,candidate}=fixture();
  candidate.profile={...base,verifiedRoot};
  let reads=0;
  service.probe=async()=>{reads++;return 'verified';};
  service.listIsolated=async()=>{reads++;return {items:[]};};
  await assert.rejects(()=>service.probeAuthorizedRoot(owner,id,'mega','Selected'),/VERIFIED_ROOT_CHANGED/);
  await assert.rejects(()=>service.listAuthorizedRoot(owner,id,'mega','Selected'),/VERIFIED_ROOT_CHANGED/);
  assert.equal(reads,0);
 }
});
test('activation locks only the exact candidate checked before transaction',async()=>{
 const {service,candidate}=fixture();
 candidate.profile={...base,verifiedRoot:'Selected'};
 const queries=[];
 service.pool.connect=async()=>({
  query:async(sql,params)=>{
   queries.push({sql,params});
   if(sql.includes('SELECT connection_id')) {
    assert.match(sql,/encrypted_profile=\$4/);
    assert.equal(params[3],'initial-ciphertext');
    // Concurrent re-enrollment replaced the inspected credential.
    return {rowCount:0};
   }
   return {rowCount:1};
  },release:()=>{},
 });
 await assert.rejects(()=>service.activate(owner,id),/VERIFICATION_REQUIRED/);
 assert.equal(queries.at(-1).sql,'ROLLBACK');
 assert.equal(queries.some(q=>q.sql.includes('DELETE FROM')),false);
});
test('root binding cannot be supplied by credential enrollment caller',async()=>{
 const {service,queries}=fixture();
 await assert.rejects(()=>service.stageCredential(owner,id,{...base,verifiedRoot:'Selected'}),/VERIFICATION_SERVER_ONLY/);
 assert.equal(queries.length,0);
});
test('failed selected-root probe cannot persist a root proof',async()=>{
 const {service,queries}=fixture();
 service.probe=async()=> 'failed';
 assert.equal(await service.probePending(owner,id,'Selected'),'failed');
 assert.equal(queries.length,0);
});
