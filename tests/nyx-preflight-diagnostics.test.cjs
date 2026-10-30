const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NyxExecutionProfileService}=require('../dist/nyx/execution-profile.service');
const {sha256}=require('../dist/nyx/resource-store.service');
const ref=path=>({area:'MAIN',path});
const cli={schema:'nyx.yarocli.v1',version:'test',commands:{}};
const cliHash=sha256(JSON.stringify(cli));
function fixture(){
 const files=new Map();
 const profile={schema:'nyx.runtime-profile.v1',authority:'user-authorized-runtime-configuration',
  cliSha256:cliHash,commands:{},keySources:[
   {key:'temp_paths',ref:ref('paths'),sha256:sha256('original')},
   {key:'temp_nyxcli',ref:ref('nyxcli'),sha256:sha256('original')},
  ]};
 files.set('profile',JSON.stringify(profile));
 files.set('paths','private changed text');
 const service=new NyxExecutionProfileService({read:async r=>{
  if(!files.has(r.path))throw Error('private provider error');
  return files.get(r.path);
 }});
 return {service,files,locator:{executionProfile:ref('profile')}};
}
test('diagnostics report every mismatched or unavailable pin without source contents',async()=>{
 const {service,locator}=fixture();
 const result=await service.inspect(locator,cliHash);
 assert.equal(result.ready,false);
 assert.deepEqual(result.keys.map(k=>[k.key,k.status]),[
  ['temp_paths','changed'],['temp_nyxcli','unavailable'],
 ]);
 assert.equal(result.keys[0].actual,sha256('private changed text'));
 assert.doesNotMatch(JSON.stringify(result),/private changed text|private provider error/);
 // Inspection does not reconcile or bypass the execution check.
 await assert.rejects(()=>service.apply(locator,cli,cliHash),/KEY_PREFLIGHT_CHANGED_REQUIRES_CHATGPT:temp_paths/);
});
test('matching pins permit preflight but a stale CLI fingerprint still blocks it',async()=>{
 const {service,files,locator}=fixture();
 files.set('paths','original');files.set('nyxcli','original');
 assert.equal((await service.inspect(locator,cliHash)).ready,true);
 const stale=await service.inspect(locator,'0'.repeat(64));
 assert.equal(stale.ready,false);assert.equal(stale.authorityMatches,false);
});
test('invalid profile returns bounded diagnostics and execution remains fail-closed',async()=>{
 const {service,files,locator}=fixture();
 files.set('profile','not JSON');
 assert.equal((await service.inspect(locator,cliHash)).error,'EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE');
 await assert.rejects(()=>service.apply(locator,cli,cliHash),/EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE/);
});

test('mutable draft changes are visible warnings, not a global init lockout',async()=>{
 const {service,files,locator}=fixture();
 const profile=JSON.parse(files.get('profile'));
 const pathsRef='🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_paths.json';
 const cliRef='🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_nyxcli.json';
 profile.keySources[0].ref=ref(pathsRef);profile.keySources[0].mode='observe';
 profile.keySources[1].ref=ref(cliRef);profile.keySources[1].mode='observe';
 files.set('profile',JSON.stringify(profile));
 files.set(pathsRef,'changed draft routing proposal'); // still untrusted, never applied
 const diagnostics=await service.inspect(locator,cliHash);
 assert.equal(diagnostics.ready,true);
 assert.equal(diagnostics.driftDetected,true);
 assert.deepEqual(diagnostics.keys.map(k=>[k.key,k.mode,k.status]),[
  ['temp_paths','observe','changed'],['temp_nyxcli','observe','unavailable'],
 ]);
 const applied=await service.apply(locator,cli,cliHash);
 assert.deepEqual(applied.keyWarnings,[
  'KEY_OBSERVE_CHANGED_REQUIRES_REVIEW:temp_paths',
  'KEY_OBSERVE_SOURCE_UNAVAILABLE:temp_nyxcli',
 ]);
 assert.deepEqual(applied.keyReceipts,[]);
 assert.deepEqual(applied.cli,cli);
 // Trusted key drift must still stop execution, even if staging drafts change.
 profile.keySources.push({key:'active_key',ref:ref('accepted-key'),sha256:sha256('original')});
 files.set('profile',JSON.stringify(profile));
 files.set('accepted-key','changed active key');
 await assert.rejects(()=>service.apply(locator,cli,cliHash),
  /KEY_PREFLIGHT_CHANGED_REQUIRES_CHATGPT:active_key/);
});
test('non-staging and arbitrary key pins cannot opt out of enforcement',async()=>{
 const {service,files,locator}=fixture();
 for(const pin of [
  {key:'active_key',ref:ref('anything'),sha256:sha256('old'),mode:'observe'},
  {key:'temp_paths',ref:ref('Documents/other/temp_paths.json'),sha256:sha256('old'),mode:'observe'},
  {key:'temp_nyxcli',ref:ref('🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_paths.json'),sha256:sha256('old'),mode:'observe'},
 ]) {
  const profile={schema:'nyx.runtime-profile.v1',authority:'user-authorized-runtime-configuration',
   cliSha256:cliHash,commands:{},keySources:[pin]};
  files.set('profile',JSON.stringify(profile));
  assert.equal((await service.inspect(locator,cliHash)).ready,false);
  await assert.rejects(()=>service.apply(locator,cli,cliHash),
   /EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE/);
 }
});
test('repository config keeps only two designated drafts in observe mode',()=>{
 const profile=require('../config/nyx-runtime-profile.json');
 assert.deepEqual(profile.keySources.filter(pin=>pin.mode==='observe').map(pin=>pin.key).sort(),
  ['temp_nyxcli','temp_paths']);
 assert.equal(profile.keySources.find(pin=>pin.key==='active_key').mode,undefined);
});
