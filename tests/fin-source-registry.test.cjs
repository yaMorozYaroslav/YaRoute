const {test}=require('node:test');
const assert=require('node:assert/strict');
const AdmZip=require('adm-zip');
const {createHash}=require('node:crypto');
const {inspectFinSource}=require('../dist/nyx/fin-source-inspection');
const {inspectNPathsRegistry,reconcileRegistryAgainstBundles}=require('../dist/nyx/fin-source-registry');
const {publicFinUpdPreflight}=require('../dist/nyx/yaro-key-fin-upd');
const sha=x=>createHash('sha256').update(x).digest('hex');
const zip=(name,entries)=>{
 const z=new AdmZip();
 for(const [path,value] of Object.entries(entries))
  z.addFile(name+'/'+path,Buffer.from(value));
 return z.toBuffer();
};
const head=zip('head_db_v032',{
 'LEAD/Core_Skills/YaRoCLI/nyxcli.json':JSON.stringify({
  schema:'nyx.yarocli.v1',commands:{key:{},fin:{},upd:{}},
 }),
});
const body=zip('body_db_v028',{'WORK/notes.json':'{}'});
const footer=zip('footer_db_v102',{
 '001_canonical_live_state.json':JSON.stringify({
  schema:'yaro_canonical_live_state',
  canonical_current:{
   head:{file:'head_db_v032.zip',sha256:sha(head)},
   body:{file:'body_db_v028.zip',sha256:sha(body)},
  },
 }),
});
const objects=[{type:'head',bytes:head,name:'head_db_v032.zip'},
 {type:'body',bytes:body,name:'body_db_v028.zip'},
 {type:'footer',bytes:footer,name:'footer_db_v102.zip'}];
const exampleRegistry=(pins={})=>Buffer.from(JSON.stringify({
 schema:'nyx.filefilter_paths.normal.v1',canonical_current:
 Object.fromEntries(objects.map(({type,bytes,name},i)=>[type,{
  file:name,drive_id:'testDrive_'+String(i+1).repeat(12),
  sha256:pins[type]||sha(bytes),
  status:'canonical_current_exact_can',
 }])),
}));
const inspections=()=>objects.map(o=>inspectFinSource(o.bytes,o.type,o.name));

test('provider-read n_paths validates exact canonical entries without claiming latest',()=>{
 const bytes=exampleRegistry();
 const r=inspectNPathsRegistry(bytes,'Documents/Nyxpad/Configs/n_paths.json');
 assert.equal(r.schema,'nyx.fin.registry-inspection.v1');
 assert.equal(r.sha256,sha(bytes));
 assert.equal(r.pointers.head.sha256,sha(head));
 assert.equal(r.latestDriveScanVerified,false);
 assert.equal(r.canonicalAuthorityVerified,false);
});
test('matching registry, Head, Body and Footer is only pointer-consistent',()=>{
 const r=inspectNPathsRegistry(exampleRegistry(),'n_paths.json');
 const plan=reconcileRegistryAgainstBundles(r,inspections());
 assert.equal(plan.registryPresent,true);
 assert.equal(plan.registryMatchesBundles,true);
 assert.deepEqual(plan.verifiedCoreClassNames,['head','body','footer']);
 assert.equal(plan.canonicalAuthorityVerified,false);
 assert.equal(plan.canonicalCurrentness,'POINTER_CONSISTENT_LATEST_UNVERIFIED');
});
test('tampered registry hash and diverging Footer pin block before any KEY write',()=>{
 const bad=inspectNPathsRegistry(exampleRegistry({head:'f'.repeat(64)}),'n_paths.json');
 assert.throws(()=>reconcileRegistryAgainstBundles(bad,inspections()),
  /FIN_REGISTRY_POINTER_MISMATCH/);
 const source=inspections();
 source[2]={...source[2],footerDeclaredPins:{
  head:{file:'head_db_v031.zip',sha256:'f'.repeat(64)},
  body:{file:'body_db_v028.zip',sha256:sha(body)},
 }};
 assert.throws(()=>reconcileRegistryAgainstBundles(
  inspectNPathsRegistry(exampleRegistry(),'n_paths.json'),source),
 /FIN_SOURCE_PIN_MISMATCH|FIN_FOOTER_REGISTRY_DIVERGENCE/);
});
test('registry path, invalid status, malformed ID, and wrong schema reject',()=>{
 assert.throws(()=>inspectNPathsRegistry(exampleRegistry(),'../n_paths.json'),/FIN_REGISTRY_SOURCE_INVALID/);
 assert.throws(()=>inspectNPathsRegistry(exampleRegistry(),'evil.json'),/FIN_REGISTRY_SOURCE_INVALID/);
 assert.throws(()=>inspectNPathsRegistry(Buffer.from('{}'),'n_paths.json'),/FIN_REGISTRY_SOURCE_INVALID|FIN_REGISTRY_STRUCTURE_INVALID/);
 const bad=JSON.parse(exampleRegistry().toString());
 bad.canonical_current.body.status='pending';
 assert.throws(()=>inspectNPathsRegistry(Buffer.from(JSON.stringify(bad)),'n_paths.json'),
  /FIN_REGISTRY_POINTER_INVALID/);
});
test('without an authenticated registry, source copies never become canonical',()=>{
 const plan=reconcileRegistryAgainstBundles(null,inspections());
 assert.equal(plan.registryPresent,false);
 assert.equal(plan.registryMatchesBundles,false);
 assert.equal(plan.canonicalAuthorityVerified,false);
});
test('FIN correctly uses source receipts but refuses incomplete global coverage',()=>{
 const evidence=inspections().map(x=>({
  sourceClass:x.sourceKind,ref:'owner-provider:'+x.pathBasename,
  sha256:x.sha256,verifiedByAdapter:true,
 }));
 evidence.push({sourceClass:'active_keys',ref:'owner-neon:temp_key.json',
  sha256:'a'.repeat(64),verifiedByAdapter:true});
 const c={id:'head_alias',target:'head',description:'Implement canonical alias from user',
  source:'chat:user:decision_1',confidence:.94};
 const p=publicFinUpdPreflight({
  scope:'global',executionId:'same_chat_id',candidates:[c],
  hasExplicitChatMessages:true,verifiedSourceReceipts:evidence,
  dispositions:[{
   id:c.id,target:c.target,status:'queued_for_target_bundle',
   reason:'Accepted user request, Head bundle not generated',
   instructions:['Update YaRoCLI KEY macro and tests'],
   source:c.source,
  }],
 });
 assert.equal(p.status,'PARTIAL_DIAGNOSTIC');
 assert.equal(p.fin.status,'PARTIAL_DIAGNOSTIC');
 assert.equal(p.fin.missingDispositions.length,0);
 assert.deepEqual(p.fin.missingSourceClasses,
  ['current_chat','pending_keys','lcb']);
 assert.equal(p.fin.sourceEvidence.length,4);
 assert.equal(p.upd.status,'BLOCKED_FIN_PRECONDITION');
 assert.equal(p.fin.finSeedCandidate,null);
 assert.equal(p.sourceCoverage.tenantKey,'owner_scoped_readback_verified');
 assert.deepEqual(p.sourceCoverage.canonicalHeadBodyFooter,['head','body','footer']);
});
test('inaccurate source attribution or disposition never yields a passing FIN',()=>{
 const c={id:'h',target:'head',description:'Keep exact source',source:'chat:user:a',
  confidence:.9};
 assert.throws(()=>publicFinUpdPreflight({
  scope:'local',executionId:'e1',candidates:[c],hasExplicitChatMessages:true,
  dispositions:[{id:'h',target:'head',status:'implemented_now',
   reason:'just because',instructions:['Do X'],source:'assistant:wrong'}],
 }),/YARO_DISPOSITION_SOURCE_MISMATCH/);
});
