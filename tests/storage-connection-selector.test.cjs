const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectVerifiedStorageConnection: choose}=require('../dist/connectors/storage-connection-selector');

const owner='oauth:google-oauth2|alice',other='oauth:google-oauth2|bob';
const namespace='mega:verified-account-A';
const root='MEGA_ROOT';
function candidate(id, capabilities=['storage:list'], providerCapabilities=capabilities,
  selected=capabilities, ownerId=owner, verifiedNamespace=namespace, pathPrefix) {
  return {
    connection:{
      id,ownerId,provider:'mega',status:'active',displayName:id,
      externalAccountId:'provider-verified',capabilities,
      providerCapabilities,resources:[{
        kind:'mega-root',id:root,capabilities:selected,
        ...(pathPrefix?{pathPrefix}:{})
      }]
    },
    verifiedOwnerId:ownerId,verifiedProvider:'mega',verifiedNamespace
  };
}
function req(operation='storage:list', overrides={}) {
  return {ownerId:owner,provider:'mega',verifiedNamespace:namespace,rootId:root,operation,...overrides};
}

test('duplicate verified namespace selects fuller effective grants regardless of order',()=>{
  const read=candidate('aaa');
  const full=candidate('bbb',['storage:list','storage:move','storage:delete']);
  assert.equal(choose([read,full],req()).id,'bbb');
  assert.equal(choose([full,read],req()).id,'bbb');
  assert.equal(choose([read,full],req('storage:move')).id,'bbb');
});

test('unverified, merely requested, and out-of-root capabilities never win',()=>{
  const read=candidate('aaa');
  const requested=candidate('bbb',['storage:list','storage:move','storage:delete'],
    ['storage:list'],['storage:list','storage:move','storage:delete']);
  assert.equal(choose([requested,read],req()).id,'aaa');
  assert.throws(()=>choose([requested,read],req('storage:move')),/NO_AUTHORIZED/);
  const wrongRoot=candidate('ccc',['storage:list','storage:move']);
  wrongRoot.connection.resources[0].id='OTHER_ROOT';
  assert.throws(()=>choose([wrongRoot],req()),/NO_AUTHORIZED/);
});

test('never crosses OAuth owner, namespace, or provider even when permission is fuller',()=>{
  const alien=candidate('alien',['storage:list','storage:move'],undefined,undefined,other);
  const otherNamespace=candidate('other-ns',['storage:list','storage:move'],undefined,undefined,owner,'mega:different');
  const wrongProvider=candidate('wrong-provider',['storage:list','storage:move']);
  wrongProvider.verifiedProvider='google-drive';
  assert.throws(()=>choose([alien,otherNamespace,wrongProvider],req()),/NO_AUTHORIZED/);
  assert.equal(choose([candidate('correct'),alien],req()).id,'correct');
});

test('selected path must remain inside explicitly granted prefix',()=>{
  const scoped=candidate('scoped',['storage:list'],undefined,undefined,owner,namespace,'Photos');
  assert.equal(choose([scoped],req('storage:list',{path:'Photos/2026'})).id,'scoped');
  assert.throws(()=>choose([scoped],req('storage:list',{path:'Documents'})),/NO_AUTHORIZED/);
  assert.throws(()=>choose([scoped],req('storage:list',{path:'Photos/../Documents'})),/INVALID/);
});

test('excludes pending or revoked connections, never upgrades them via selection',()=>{
  const active=candidate('active');
  const pending=candidate('pending',['storage:list','storage:move']);
  pending.connection.status='pending';
  assert.equal(choose([pending,active],req()).id,'active');
  active.connection.status='revoked';
  assert.throws(()=>choose([pending,active],req()),/NO_AUTHORIZED/);
});

test('ties resolve to stable connection ID, independently of database enumeration',()=>{
  const a=candidate('aaa'),b=candidate('bbb');
  assert.equal(choose([b,a],req()).id,'aaa');
  assert.equal(choose([a,b],req()).id,'aaa');
});

test('invalid requests fail closed',()=>{
  assert.throws(()=>choose([],req('storage:list',{ownerId:'unverified'})),/INVALID/);
  assert.throws(()=>choose([],req('storage:list',{path:'../secret'})),/INVALID/);
  assert.throws(()=>choose([],req('repository:metadata')),/INVALID/);
});

test('Google Drive duplicate selection uses verified namespace and exact root',()=>{
  const narrow=candidate('drive-a',['storage:list']);
  const broad=candidate('drive-b',['storage:list','storage:move']);
  for (const item of [narrow,broad]) {
    item.connection.provider='google-drive';
    item.verifiedProvider='google-drive';
    item.verifiedNamespace='my-drive:permission-id';
    item.connection.resources[0].kind='drive';
    item.connection.resources[0].id='root';
  }
  const request=req('storage:list',{provider:'google-drive',
    verifiedNamespace:'my-drive:permission-id',rootId:'root'});
  assert.equal(choose([narrow,broad],request).id,'drive-b');
  assert.throws(()=>choose([narrow,broad],{...request,rootId:'other'}),/NO_AUTHORIZED/);
});

test('relabeling a connection cannot change identity or win selection by itself',()=>{
  const a=candidate('aaa'),b=candidate('bbb');
  b.connection.displayName='Extremely powerful admin account';
  assert.equal(choose([b,a],req()).id,'aaa');
});
