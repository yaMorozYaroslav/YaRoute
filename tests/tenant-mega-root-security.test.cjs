const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const {TenantMegaEnrollmentService}=require('../dist/connectors/tenant-mega-enrollment.service');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const TEST_EMAIL=['nobody','example.invalid'].join('@');
const owner='oauth:alice',id='11111111-2222-4333-8444-555555555555';
const profile={provider:'mega',user:TEST_EMAIL,obscuredPassword:'obscured-test-only'};
const connection=(roots=['TeamDocs'])=>({
 ownerId:owner,id,provider:'mega',status:'pending',externalAccountId:'pending',
 capabilities:['storage:list'],providerCapabilities:[],
 resources:roots.map(root=>({kind:'mega-root',id:root,capabilities:['storage:list']})),
});
function fixture(roots=['TeamDocs']) {
 const item=connection(roots),traces=[];
 const connectors={getOwned:async(o,k)=> {
   if(o!==owner||k!==id)throw Error('FOREIGN_TENANT_DENIED');
   return item;
 }};
 const svc=new TenantRcloneService(connectors);
 svc.encryptionKey=Buffer.alloc(32,7);
 svc.profile=async()=>({provider:'mega',profile,packed:'sealed-placeholder'});
 svc.probe=async(_p,path)=>{traces.push(path);return path==='TeamDocs'?'verified':'failed';};
 svc.pool={query:async(sql,p)=>{traces.push({sql,params:p});return {rowCount:1}}};
 return {svc,item,traces};
}
test('new MEGA credential is verified at selected root, not account root',async()=>{
 const {svc,traces}=fixture();
 assert.equal(await svc.probePending(owner,id,'TeamDocs'),'verified');
 assert.equal(traces[0],'TeamDocs');
 assert.equal(traces.length,2);
 assert.match(traces[1].sql,/read_verified_at=now/);
});
test('account root success does not falsely verify an inaccessible selected folder',async()=>{
 const {svc,traces}=fixture(['MissingFolder']);
 svc.probe=async(_p,path)=>{traces.push(path);return path===''?'verified':'failed';};
 assert.equal(await svc.probePending(owner,id,'MissingFolder'),'failed');
 assert.deepEqual(traces,['MissingFolder']);
});
test('MEGA_ROOT special marker legitimately probes account root',async()=>{
 const {svc,traces}=fixture(['MEGA_ROOT']);
 svc.probe=async(_p,path)=>{traces.push(path);return path===''?'verified':'failed';};
 assert.equal(await svc.probePending(owner,id,'MEGA_ROOT'),'verified');
 assert.equal(traces[0],'');
});
test('changing selected root after enrollment makes probe fail closed',async()=>{
 const {svc,traces}=fixture(['Changed']);
 await assert.rejects(()=>svc.probePending(owner,id,'Original'),
   /TENANT_MEGA_SELECTED_ROOT_CHANGED/);
 assert.equal(traces.length,0);
});
test('multiple or missing authorized roots fail closed before any read',async()=>{
 for(const roots of [[],['First','Second']]){
   const {svc,traces}=fixture(roots);
   await assert.rejects(()=>svc.probePending(owner,id),/TENANT_MEGA_EXACT_ROOT_REQUIRED/);
   assert.equal(traces.length,0);
 }
});
test('traversal, colon and invalid MEGA selected roots are refused',async()=>{
 for(const root of ['../private','a/../b','remote:path','/absolute']){
   const {svc,traces}=fixture([root]);
   await assert.rejects(()=>svc.probePending(owner,id,root),/TENANT_RCLONE_PATH_INVALID/);
   assert.equal(traces.length,0);
 }
});
test('wrong provider or foreign owner cannot probe MEGA pending credential',async()=>{
 const {svc,traces,item}=fixture();
 await assert.rejects(()=>svc.probePending('oauth:bob',id),/TENANT_RCLONE_CONNECTION_FORBIDDEN/);
 item.provider='google-drive';
 await assert.rejects(()=>svc.probePending(owner,id),/TENANT_RCLONE_PROVIDER_MISMATCH/);
 assert.equal(traces.length,0);
});
test('MEGA enrollment passes one-time verified root through to read probe',async t=>{
 const old=process.env.NYX_PUBLIC_URL;
 process.env.NYX_PUBLIC_URL='https://dev.example.invalid';
 t.after(()=>{if(old===undefined)delete process.env.NYX_PUBLIC_URL;
   else process.env.NYX_PUBLIC_URL=old;});
 const c=connection(['TeamDocs']),calls=[],confirmed=[];
 const connectors={
   getOwned:async(o,k)=>{assert.equal(o,owner);assert.equal(k,id);return c;},
   confirmStorageProvider:async(...args)=>confirmed.push(args),
 };
 const storage={
   stageCredential:async(...args)=>calls.push(['stage',...args]),
   probePending:async(...args)=>{calls.push(['probe',...args]);return 'verified';},
 };
 const enrol=new TenantMegaEnrollmentService(connectors,storage);
 let saved;
 enrol.pool={query:async(sql,params)=>{
   if(sql.includes('INSERT INTO'))saved={owner_id:params[1],connection_id:params[2],root_path:params[3]};
   if(sql.includes('RETURNING'))return {rowCount:1,rows:[saved]};
   return {rowCount:1};
 }};
 enrol.obscure=async()=> 'test-obscured-string';
 const url=await enrol.begin(owner,id,'TeamDocs');
 const state=new URL(url.url).searchParams.get('state');
 assert.equal((await enrol.complete(state,TEST_EMAIL,'test password')).status,'pending_activation');
 assert.deepEqual(calls.find(c=>c[0]==='probe'),['probe',owner,id,'TeamDocs']);
 assert.equal(confirmed.length,1);
});
test('MEGA enrollment cannot accept changed root or failed selected-root read',async()=>{
 const c=connection(['Different']);
 const confirmed=[];
 const en=new TenantMegaEnrollmentService({
   getOwned:async()=>c,confirmStorageProvider:async(...args)=>confirmed.push(args),
 },{
   stageCredential:async()=>{},
   probePending:async()=>{throw Error('TENANT_MEGA_SELECTED_ROOT_CHANGED');}
 });
 en.pool={query:async()=>({rowCount:1,rows:[{owner_id:owner,connection_id:id,root_path:'Original'}]})};
 en.obscure=async()=> 'obscured';
 await assert.rejects(()=>en.complete('a'.repeat(45),TEST_EMAIL,'pw'),
   /TENANT_MEGA_CONNECTION_CHANGED|TENANT_MEGA_SELECTED_ROOT_CHANGED/);
 assert.equal(confirmed.length,0);
});
test('isolated MEGA root selection accepts one and rejects multiple',async()=>{
 const svc=new ConnectorsService();
 svc.assertTenantStorageMode=()=>{};
 svc.owned=async()=>connection();
 svc.policy=()=>({setResources:async(_o,_id,resources)=>({...connection(),resources})});
 assert.deepEqual((await svc.storageResources(owner,id,[{
   kind:'mega-root',id:'TeamDocs',capabilities:['storage:list'],
 }])).resources.map(x=>x.id),['TeamDocs']);
 await assert.rejects(()=>svc.storageResources(owner,id,[
   {kind:'mega-root',id:'TeamDocs',capabilities:['storage:list']},
   {kind:'mega-root',id:'Private',capabilities:['storage:list']},
 ]),/TENANT_MEGA_SINGLE_ROOT_REQUIRED/);
});
