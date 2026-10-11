const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {MegaSetupService}=require('../dist/connectors/mega-setup.service');
const {megaSetupPage}=require('../dist/connectors/mega-setup.controller');
const {obscureMegaPassword,megaProfile}=require('../dist/connectors/mega-obscure');

const state='s'.repeat(43);
const remote='mega_personal';
const profile='['+remote+']\ntype = mega\nuser = sample@example.com\npass = '+'A'.repeat(32)+'\n';

function flags(t){
  const keys=['NYX_MEGA_SELF_SERVICE_ENABLED','NYX_RCLONE_VAULT_ENABLED',
    'NYX_PUBLIC_CONNECTORS_ENABLED','NYX_PUBLIC_URL'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(old))
    v===undefined?delete process.env[k]:process.env[k]=v;});
  Object.assign(process.env,{NYX_MEGA_SELF_SERVICE_ENABLED:'true',
    NYX_RCLONE_VAULT_ENABLED:'true',NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_PUBLIC_URL:'https://nestnyx.example'});
}

test('MEGA page explains direct credentials, permissions and never requests recovery keys',()=>{
  const html=megaSetupPage(state,remote);
  assert.match(html,/MEGA account password/);
  assert.match(html,/value="manage"/);
  assert.match(html,/value="read"/);
  assert.match(html,/not active until separate permission-enforced tools/);
  assert.match(html,/No API key or recovery key is required/);
  assert.match(html,/action="\/connect\/mega\/setup"/);
  assert.match(html,/<textarea[^>]+name="profile"/);
  assert.match(html,/name="state"/);
  assert.match(html,/type="password" name="password"/);
  assert.doesNotMatch(html,/name="recoveryKey"/);
  assert.throws(()=>megaSetupPage('invalid','good'),/MEGA_SETUP_LINK_INVALID/);
  assert.throws(()=>megaSetupPage(state,'bad"><script>'),/MEGA_SETUP_LINK_INVALID/);
});

test('owner-bound MEGA setup state is expiring, one-use and rejects other tenant',async t=>{
  flags(t);
  const row={id:'123e4567-e89b-42d3-a456-426614174000',
    ownerId:'oauth:alice',provider:'mega',externalAccountId:remote,status:'pending'};
  const states=new Map();
  const vault={isEnabled:()=>true};
  const svc=new ConnectorsService({},vault);
  svc.repository={get:async id=>id===row.id?row:null};
  svc.registry={list:async()=>[]};
  svc.pool={query:async(sql,args)=>{
    if(sql.includes('INSERT INTO nyx_mega_setup_request_limits')){
      return{rowCount:1,rows:[]};
    }
    if(sql.startsWith('DELETE FROM nyx_mega_setup_states WHERE expires_at<=now()')){
      states.clear();return{rowCount:0,rows:[]};
    }
    if(sql.includes('INSERT INTO nyx_mega_setup_states')){
      states.set(args[0],{owner_id:args[1],connection_id:args[2]});
      return {rowCount:1,rows:[]};
    }
    if(sql.startsWith('SELECT owner_id,connection_id FROM nyx_mega_setup_states')){
      const v=states.get(args[0]);
      return {rowCount:v?1:0,rows:v?[v]:[]};
    }
    if(sql.startsWith('DELETE FROM nyx_mega_setup_states WHERE state_digest=')){
      const v=states.get(args[0]);states.delete(args[0]);
      return {rowCount:v?1:0,rows:v?[v]:[]};
    }
    throw Error('Unexpected SQL');
  }};
  await assert.rejects(()=>svc.beginMegaSetup('oauth:bob',row.id),/CONNECTOR_NOT_FOUND/);
  const started=await svc.beginMegaSetup('oauth:alice',row.id);
  const url=new URL(started.setupUrl);
  assert.equal(url.origin,'https://nestnyx.example');
  assert.equal(url.pathname,'/connect/mega/setup');
  assert.equal(started.expiresInSeconds,600);
  const token=url.searchParams.get('state');
  assert.equal(token.length,43);
  assert.deepEqual(await svc.inspectMegaSetupState(token),{remote});
  const consumed=await svc.consumeMegaSetupState(token);
  assert.equal(consumed.ownerId,'oauth:alice');
  assert.equal(consumed.remote,remote);
  await assert.rejects(()=>svc.consumeMegaSetupState(token),/MEGA_SETUP_STATE_EXPIRED/);
});

test('MEGA setup only accepts one bounded remote profile, never plaintext recovery codes or other remotes',async t=>{
  flags(t);
  const stored=[];
  const connections={consumeMegaSetupState:async()=>({
    ownerId:'oauth:alice',connectionId:'123e4567-e89b-42d3-a456-426614174000',remote})};
  const vault={isEnabled:()=>true,store:async(...args)=>{stored.push(args);return{stored:true}}};
  const svc=new MegaSetupService(connections,vault);
  const result=await svc.complete(state,profile);
  assert.equal(result.stored,true);
  assert.equal(result.verification,'unverified');
  assert.equal(stored.length,1);
  assert.equal(stored[0][0],'oauth:alice');
  assert.equal(stored[0][2],'mega');
  await assert.rejects(()=>svc.complete(state,
    '[other]\ntype = mega\nuser = sample@example.com\npass = '+ 'A'.repeat(32)+'\n'),/RCLONE_PROFILE_INVALID/);
  await assert.rejects(()=>svc.complete(state,
    profile+'session_id = leaked-value\n'),/RCLONE_PROFILE_INVALID|MEGA_PROFILE_INVALID/);
  await assert.rejects(()=>svc.complete(state,
    profile+'2fa = 123456\n'),/RCLONE_PROFILE_INVALID|MEGA_PROFILE_INVALID/);
  assert.equal(stored.length,1);
  process.env.NYX_MEGA_SELF_SERVICE_ENABLED='false';
  await assert.rejects(()=>svc.complete(state,profile),/MEGA_SELF_SERVICE_DISABLED/);
});

test('MEGA public connectivity checks are owner-scoped and atomically throttled',async t=>{
  flags(t);
  const old=process.env.NYX_DEPLOYMENT_MODE;
  t.after(()=>{if(old===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
    else process.env.NYX_DEPLOYMENT_MODE=old;});
  process.env.NYX_DEPLOYMENT_MODE='public';
  const id='123e4567-e89b-42d3-a456-426614174000';
  const row={id,ownerId:'oauth:alice',provider:'mega',
    externalAccountId:remote,displayName:'Alice MEGA',status:'pending'};
  let callCount=0,providerCalls=0;
  const svc=new ConnectorsService({
    testRcloneConnection:async()=>{throw Error('shared config must be disabled');},
    testIsolatedRcloneConnection:async()=>{
      providerCalls++;return {schema:'nyx.storage.rclone.probe.v1',
        status:'reachable',configurationChanged:false};
    },
  },{isEnabled:()=>true,load:async()=>profile});
  svc.repository={get:async key=>key===id?row:null};
  svc.registry={list:async()=>[row]};
  let activationCount=0;
  svc.pool={query:async(sql,args)=>{
    if(sql.includes('UPDATE nyx_connector_connections')){
      assert.deepEqual(args,[id,'oauth:alice']);activationCount++;
      row.status='active';
      return{rowCount:1,rows:[]};
    }
    assert.ok(sql.includes('nyx_mega_probe_limits'));
    assert.deepEqual(args,['oauth:alice',id]);
    return{rowCount:++callCount===1?1:0,rows:[]};
  }};
  await assert.rejects(()=>svc.testRclone('oauth:bob',id),/CONNECTOR_NOT_FOUND/);
  assert.equal((await svc.testRclone('oauth:alice',id)).status,'reachable');
  await assert.rejects(()=>svc.testRclone('oauth:alice',id),/MEGA_PROBE_COOLDOWN/);
  assert.equal(providerCalls,1);
  assert.equal(activationCount,1);
  assert.equal(row.status,'active');
});

test('Direct MEGA password is obscured through Rclone stdin; only resulting single profile is stored',async t=>{
  flags(t);
  const result=await obscureMegaPassword('sample-test-only-password');
  assert.ok(result.length>=16);
  assert.ok(!result.includes('sample-test-only-password'));
  const txt=megaProfile(remote,'sample@example.com',result);
  assert.match(txt,/type = mega/);
  assert.match(txt,/pass = /);
  assert.ok(!txt.includes('sample-test-only-password'));
  await assert.rejects(()=>obscureMegaPassword('password'+String.fromCharCode(10)+'exfil'),/MEGA_PASSWORD_INVALID/);
  assert.throws(()=>megaProfile('bad'+String.fromCharCode(10)+'remote','sample@example.com',result),/MEGA_SETUP_INPUT_INVALID/);

  const stored=[],prefs=[];
  const svc=new MegaSetupService({
    consumeMegaSetupState:async()=>({ownerId:'oauth:alice',
      connectionId:'123e4567-e89b-42d3-a456-426614174000',remote}),
    recordMegaAccessRequest:async(...values)=>prefs.push(values),
  },{isEnabled:()=>true,store:async(...args)=>{stored.push(args);}});
  const connected=await svc.completeCredentials(state,'sample@example.com',
    'sample-test-only-password','manage');
  assert.equal(connected.effectiveMode,'read-only-probe');
  assert.equal(connected.requestedMode,'manage');
  assert.equal(stored.length,1);
  assert.equal(stored[0][0],'oauth:alice');
  assert.equal(stored[0][2],'mega');
  assert.ok(stored[0][4].includes('type = mega'));
  assert.ok(!stored[0][4].includes('sample-test-only-password'));
  assert.deepEqual(prefs[0].slice(0,2),['oauth:alice','123e4567-e89b-42d3-a456-426614174000']);
  assert.equal(prefs[0][2],'manage');
});
