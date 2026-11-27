const {test}=require('node:test');
const assert=require('node:assert/strict');
const AdmZip=require('adm-zip');
const {createHash}=require('node:crypto');
const {inspectFinSource,reconcileFinSourcePins}=require('../dist/nyx/fin-source-inspection');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const H='head_db_v033',B='body_db_v029',F='footer_db_v103';
const checksum=x=>createHash('sha256').update(x).digest('hex');
const bundle=(root,members)=>{const a=new AdmZip();for(const [p,data] of Object.entries(members))a.addFile(root+'/'+p,Buffer.from(data));return a.toBuffer();};
const head=bundle(H,{'LEAD/Core_Skills/YaRoCLI/nyxcli.json':JSON.stringify({
  schema:'nyx.yarocli.v1',commands:{key:{},fin:{},upd:{}},
}),'LEAD/Yaro_Compact_Command_Grammar_v009.json':'{}'});
const body=bundle(B,{'HEAD_REFERENCE_v029.json':'{}','WORK/config.json':'{}'});
const footer=bundle(F,{'001_canonical_live_state.json':JSON.stringify({
 schema:'yaro_canonical_live_state',canonical_current:{
  head:{file:'head_db_v033.zip',sha256:checksum(head)},
  body:{file:'body_db_v029.zip',sha256:checksum(body)},
 }
})});
test('byte evidence is server-derived, preserves Footer declared pins without falsely claiming canonical current',()=>{
 const h=inspectFinSource(head,'head',H+'.zip');
 const b=inspectFinSource(body,'body','0_core/'+B+'.zip');
 const f=inspectFinSource(footer,'footer','2_footer/'+F+'.zip');
 assert.equal(h.sha256,checksum(head));assert.equal(h.declaredVersion,'v033');
 assert.equal(b.sha256,checksum(body));assert.equal(f.sha256,checksum(footer));
 assert.equal(f.footerDeclaredPins.head.sha256,h.sha256);
 assert.equal(f.footerDeclaredPins.body.sha256,b.sha256);
 assert.equal(f.canonicalAuthorityVerified,false);
 assert.equal(h.claimedCanonicalCurrent,false);
 assert.equal(f.structuralChecks,'PASS');
});
test('wrong type, missing canonical marker, JSON that lies about schema fail',()=>{
 assert.throws(()=>inspectFinSource(body,'head','head_db_v029.zip'),/FIN_SOURCE_ARCHIVE_STRUCTURE_INVALID/);
 const missing=bundle('head_db_v033',{'random.txt':'x'});
 assert.throws(()=>inspectFinSource(missing,'head','head_db_v033.zip'),/FIN_SOURCE_ARCHIVE_STRUCTURE_INVALID/);
 const lies=bundle('head_db_v033',{'LEAD/Core_Skills/YaRoCLI/nyxcli.json':JSON.stringify({schema:'fake',commands:{}})});
 assert.throws(()=>inspectFinSource(lies,'head','head_db_v033.zip'),/FIN_SOURCE_MANIFEST_INVALID/);
 assert.throws(()=>inspectFinSource(Buffer.from('not a zip'),'head','head_db_v033.zip'),/FIN_SOURCE_ZIP_INVALID/);
});
test('rejects path traversal, oversized buffers, empty file, unrelated input',()=>{
 for(const bad of ['../head_db_v033.zip','/head_db_v033.zip','core\\head_db_v033.zip',
   'core/../head_db_v033.zip','core/./head_db_v033.zip']){
  assert.throws(()=>inspectFinSource(head,'head',bad),/FIN_SOURCE_PATH_INVALID/);
 }
 assert.throws(()=>inspectFinSource(Buffer.alloc(0),'head',H+'.zip'),/FIN_SOURCE_SIZE_INVALID/);
 assert.throws(()=>inspectFinSource(Buffer.alloc(16*1024*1024+1),'head',H+'.zip'),/FIN_SOURCE_SIZE_INVALID/);
 assert.throws(()=>inspectFinSource(head,'footer',H+'.zip'),/FIN_SOURCE_ARCHIVE_NAME_INVALID/);
});
test('pending-key JSON byte verification returns digest, never raw content',()=>{
 const input=Buffer.from(JSON.stringify({candidates:[{id:'secret',description:'Not returned'}]}));
 const r=inspectFinSource(input,'pending_keys','temp_key.json');
 assert.equal(r.sourceKind,'pending_keys');
 assert.equal(r.sha256,checksum(input));
 assert.ok(!JSON.stringify(r).includes('Not returned'));
});
function service(){
 const s=Object.create(TenantRcloneService.prototype);
 s.connectors={registryPolicy:()=>({requireResource:async()=>true})};
 s.authorizedTarget=async()=>({profile:{provider:'google-drive'},packed:'secret',path:'x'});
 s.readIsolatedFinSource=async()=>Buffer.from('SOURCE');
 return s;
}
async function withEnv(fn){
 const prev={mode:process.env.NYX_DEPLOYMENT_MODE,flag:process.env.NYX_PUBLIC_NYX_SOURCE_READ_ENABLED};
 try{process.env.NYX_DEPLOYMENT_MODE='public';delete process.env.NYX_PUBLIC_NYX_SOURCE_READ_ENABLED;return await fn();}
 finally{if(prev.mode===undefined)delete process.env.NYX_DEPLOYMENT_MODE;else process.env.NYX_DEPLOYMENT_MODE=prev.mode;
  if(prev.flag===undefined)delete process.env.NYX_PUBLIC_NYX_SOURCE_READ_ENABLED;else process.env.NYX_PUBLIC_NYX_SOURCE_READ_ENABLED=prev.flag;}
}
test('exact source read must check storage:read grant before provider IO',()=>withEnv(async()=>{
 const s=service();let opens=0;let requirements=[];
 s.connectors.registryPolicy=()=>({requireResource:async(o,id,cap,res)=>{
  requirements.push({o,id,cap,res});throw Error('CONNECTOR_FORBIDDEN');}});
 s.authorizedTarget=async()=>{opens++;throw Error('SHOULD_NEVER_READ');};
 await assert.rejects(()=>s.readAuthorizedFinSource('oauth:o',
  '12345678-1234-1234-1234-123456789012','google-drive','root','head_db_v033.zip'),
  /CONNECTOR_FORBIDDEN/);
 assert.equal(opens,0);
 assert.equal(requirements.length,1);
 assert.equal(requirements[0].cap,'storage:read');
 assert.equal(requirements[0].res.id,'root');
}));
test('path traversal and source-read kill switch fail before authorization',()=>withEnv(async()=>{
 const s=service();let attempts=0;
 s.connectors.registryPolicy=()=>({requireResource:async()=>{attempts++;}});
 await assert.rejects(()=>s.readAuthorizedFinSource('oauth:o','id','google-drive',
  'root','../../private'),/TENANT_RCLONE_PATH_INVALID/);
 assert.equal(attempts,0);
 process.env.NYX_PUBLIC_NYX_SOURCE_READ_ENABLED='false';
 await assert.rejects(()=>s.readAuthorizedFinSource('oauth:o','id','google-drive',
  'root','head_db_v033.zip'),/FIN_SOURCE_READ_DISABLED/);
 assert.equal(attempts,0);
}));
test('provider preflight does not silently enable user/root permissions',()=>withEnv(async()=>{
 const s=service();let enabled=0;
 s.probeAuthorizedRoot=async()=> 'verified';
 s.connectors.attestFinSourceReadAvailable=async()=>{enabled++;return {
   providerReadAvailable:true,userReadPermissionEnabled:false,noPermissionsChanged:true,noRootsChanged:true}};
 const r=await s.prepareFinSourceRead('oauth:o','id','google-drive','root');
 assert.equal(enabled,1);
 assert.equal(r.userReadPermissionEnabled,false);
 assert.equal(r.noPermissionsChanged,true);
 s.probeAuthorizedRoot=async()=> 'failed';
 await assert.rejects(()=>s.prepareFinSourceRead('oauth:o','id','google-drive','root'),
  /FIN_SOURCE_PROVIDER_PROBE_REQUIRED/);
 assert.equal(enabled,1);
}));

test('valid provider-read Head+Body match Footer declared pins but do not claim currentness',()=>{
 const set=[inspectFinSource(head,'head',H+'.zip'),
   inspectFinSource(body,'body',B+'.zip'),
   inspectFinSource(footer,'footer',F+'.zip')];
 const result=reconcileFinSourcePins(set);
 assert.equal(result.internallyConsistentWithFooter,true);
 assert.deepEqual(result.matchedPointers,['head','body']);
 assert.equal(result.canonicalAuthorityVerified,false);
 assert.equal(result.canonicalCurrentness,'NOT_VERIFIED');
 assert.equal(result.pendingKeysAndLcbReconciled,false);
});
test('mismatched and duplicated Head cannot pass a FIN source preflight',()=>{
 const h=inspectFinSource(head,'head',H+'.zip');
 const b=inspectFinSource(body,'body',B+'.zip');
 const f=inspectFinSource(footer,'footer',F+'.zip');
 assert.throws(()=>reconcileFinSourcePins([{...h,sha256:'f'.repeat(64)},b,f]),/FIN_SOURCE_PIN_MISMATCH/);
 assert.throws(()=>reconcileFinSourcePins([h,h,b,f]),/FIN_SOURCE_CLASS_DUPLICATE/);
 const partial=reconcileFinSourcePins([f]);
 assert.equal(partial.internallyConsistentWithFooter,false);
 assert.deepEqual(partial.missingSourceClasses,['head','body']);
});
