const {test}=require('node:test');
const assert=require('node:assert/strict');
const {inspectIniReadiness,REQUIRED_INI_GATES}=require('../dist/nyx/init-readiness');

test('INI is never READY from code compilation, archive hashes or HTTP health alone',()=>{
  const result=inspectIniReadiness({live_runtime_feature_verified:true});
  assert.equal(result.status,'PARTIAL_DIAGNOSTIC');
  assert.equal(result.complete,false);
  assert.equal(result.missingGates.includes('conversation_fif_persisted_and_read_back'),true);
  assert.equal(result.missingGates.includes('all_required_visible_renders_verified'),true);
  assert.equal(result.missingGates.includes('canonical_pointer_verified'),true);
});

test('each of seven mandatory receipts blocks completion independently',()=>{
  const complete=Object.fromEntries(REQUIRED_INI_GATES.map(x=>[x,true]));
  assert.deepEqual(inspectIniReadiness(complete).missingGates,[]);
  assert.equal(inspectIniReadiness(complete).status,'READY');
  for(const gate of REQUIRED_INI_GATES){
    const incomplete={...complete,[gate]:false};
    const r=inspectIniReadiness(incomplete);
    assert.equal(r.status,'PARTIAL_DIAGNOSTIC',gate);
    assert.deepEqual(r.missingGates,[gate]);
  }
});

test('unverified, missing and truthy nonboolean receipts never pass',()=>{
  for(const flag of [undefined,null,0,'true',{verified:true}]){
    const candidate=Object.fromEntries(REQUIRED_INI_GATES.map(x=>[x,true]));
    candidate.live_runtime_feature_verified=flag;
    assert.equal(inspectIniReadiness(candidate).complete,false);
  }
});

test('the diagnostic never pretends to persist session state',()=>{
 const r=inspectIniReadiness({});
 assert.equal(r.checksOnly,true);
 assert.equal(r.status,'PARTIAL_DIAGNOSTIC');
 assert.deepEqual(r.missingGates,[...REQUIRED_INI_GATES]);
});
