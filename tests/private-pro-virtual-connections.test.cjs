const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {
  PRIVATE_REMOTE_ROOT, privateRemoteView, findPrivateRemote,
}=require('../dist/connectors/private-pro-virtual-connections');

const key=randomBytes(32).toString('base64');
const remotes=[
  ...Array.from({length:6},(_,i)=>({name:'drive_'+(i+1),provider:'google-drive'})),
  {name:'mega_primary',provider:'mega'},
  {name:'mega_secondary',provider:'mega'},
];

test('eight broker remote handles are stable, scoped to Personal and never credential grants',()=>{
  const personal='oauth:google-oauth2|personal',other='oauth:google-oauth2|primary';
  const mapped=remotes.map(remote=>privateRemoteView(personal,remote,key));
  assert.equal(mapped.length,8);
  assert.equal(new Set(mapped.map(x=>x.id)).size,8);
  for(let i=0;i<mapped.length;i++){
    const view=mapped[i],remote=remotes[i];
    assert.match(view.id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(view.id,privateRemoteView(personal,remote,key).id);
    assert.notEqual(view.id,privateRemoteView(other,remote,key).id);
    assert.deepEqual(view.capabilities,['storage:list']);
    assert.deepEqual(view.providerCapabilities,[]);
    assert.deepEqual(view.availableCapabilities,['storage:list']);
    assert.equal(view.source,'private-pro-broker');
    assert.equal(view.status,'pending');
    assert.equal(view.resources[0].id,PRIVATE_REMOTE_ROOT);
    assert.deepEqual(findPrivateRemote(personal,view.id,remotes,key),remote);
    assert.equal(findPrivateRemote(other,view.id,remotes,key),null);
    assert.doesNotMatch(JSON.stringify(view),/oauth:|rclone.conf|password|token|refresh/);
  }
});
test('private remote metadata input and duplicated inventory fail closed',()=>{
  assert.throws(()=>privateRemoteView('unverified',{name:'remote',provider:'mega'},key),/VIEW_INVALID/);
  for(const name of ['../outside','evil:remote','/absolute','remote\\other','']){
    assert.throws(()=>privateRemoteView('oauth:owner',{name,provider:'mega'},key),/VIEW_INVALID/);
  }
  assert.throws(()=>findPrivateRemote('oauth:owner','id',[remotes[0],remotes[0]],key),
    /INVENTORY_INVALID/);
  assert.throws(()=>findPrivateRemote('oauth:owner','id',new Array(21).fill(remotes[0]),key),
    /INVENTORY_INVALID/);
});
test('public owner-link and private allowlist are rechecked for every virtual storage operation',()=>{
  const mcp=fs.readFileSync(path.join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');
  const broker=fs.readFileSync(path.join(__dirname,'..','src','connectors','private-legacy-broker.service.ts'),'utf8');
  const client=fs.readFileSync(path.join(__dirname,'..','src','connectors','private-legacy-broker.client.ts'),'utf8');
  const storage=fs.readFileSync(path.join(__dirname,'..','src','storage','storage.service.ts'),'utf8');
  assert.match(mcp,/this\.ownerLink\.status\(ownerId\)/);
  assert.match(mcp,/if\(!link\.eligible\|\|!link\.linked\)return \[\]/);
  assert.match(mcp,/this\.privateBroker\.connections\(ownerId\)/);
  assert.match(mcp,/findPrivateRemote\(ownerId,id,available/);
  assert.match(mcp,/this\.privateBroker\.listRemote\(ownerId,remote\.name,path\|\|''\)/);
  assert.match(mcp,/TENANT_RCLONE_CONNECTION_FORBIDDEN/);
  assert.match(broker,/NYX_PRIVATE_BROKER_ALLOWED_REMOTES/);
  assert.match(broker,/cfg\.remotes\.includes\(claims\.root\)/);
  assert.match(client,/trustedBrokerIdentity\(ownerId\)/);
  assert.match(storage,/async privateRemoteList\(/);
  assert.match(storage,/NYX_DEPLOYMENT_MODE !== 'private'/);
  assert.doesNotMatch(mcp,/RCLONE_CONFIG_B64\s*=/);
});
