const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDecipheriv}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const importer=()=>import(pathToFileURL(path.resolve('scripts/nyx-neon-owner-rclone-import.mjs')).href);
const owner='oauth:google-oauth2|123456789012345678';
function fixture() {
  const config={};
  const manifest={ownerId:owner,remotes:[]};
  for(let i=0;i<6;i++){
    const remote='drive_'+i;
    const root=i===3?'folder_'+i:'root';
    config[remote]={type:'drive',token:JSON.stringify({
      access_token:'fixture-token-'+i,refresh_token:'fixture-refresh-'+i})};
    if(i===3)config[remote].root_folder_id=root;
    // Mirrors the observed legacy inventory: team_drive key is present on all Drives.
    config[remote].team_drive=i===1?'0A_shared_fixture_01':'';
    manifest.remotes.push({remote,rootId:root,displayName:'Drive '+i});
  }
  for(let i=0;i<2;i++) {
    const remote='mega_'+i;
    config[remote]={type:'mega',user:['example'+i,'example.com'].join('@'),
      pass:'fixture-obscured-'+i};
    manifest.remotes.push({remote,rootId:'MEGA_ROOT',displayName:'MEGA '+i});
  }
  return {config,manifest};
}
test('read-only inventory returns option names but no stored credential values',async()=>{
  const {safeInventory}=await importer();
  const {config}=fixture();
  const summary=safeInventory(config);
  assert.equal(summary.length,8);
  assert.ok(summary.every(x=>x.hasCredential&&x.supported));
  assert.equal(summary.filter(x=>x.provider==='google-drive').length,6);
  assert.equal(summary[1].teamDriveMode,'selected');
  assert.equal(summary[0].teamDriveMode,'not-selected');
  const serialized=JSON.stringify(summary);
  assert.doesNotMatch(serialized,/fixture-token|fixture-obscured|fixture-refresh|0A_shared_fixture_01/);
});
test('exact eight: six Drive, two MEGA, scoped roots and no unknown config fields',async()=>{
  const {buildPendingImport}=await importer();
  const {config,manifest}=fixture();
  const plan=buildPendingImport(config,manifest);
  assert.equal(plan.rows.length,8);
  assert.equal(plan.rows[0].profile.rootFolderId,'root');
  assert.equal(plan.rows[0].profile.accountRoot,true);
  assert.equal(plan.rows[3].profile.accountRoot,undefined);
  assert.equal(plan.rows[3].profile.rootFolderId,'folder_3');
  assert.equal(plan.rows[1].profile.teamDriveId,'0A_shared_fixture_01');
  assert.equal(plan.rows[0].profile.teamDriveId,undefined);
  assert.equal(plan.rows[6].kind,'mega-root');
  assert.equal(plan.rows[0].profile.token,config.drive_0.token);
  assert.throws(()=>{
    manifest.remotes[0].rootId='other';
    buildPendingImport(config,manifest);
  },/DRIVE_ROOT_MISMATCH/);
});
test('refuse owner swaps, unsupported options, partial remote lists and wrong root',async()=>{
  const {buildPendingImport}=await importer();
  const {config,manifest}=fixture();
  manifest.ownerId='oauth:password|123456789012345678';
  assert.throws(()=>buildPendingImport(config,manifest),/MANIFEST_INVALID/);
  manifest.ownerId=owner;
  config.drive_0.service_account_file='/home/a/private';
  assert.throws(()=>buildPendingImport(config,manifest),/UNSUPPORTED_RCLONE_OPTION/);
  delete config.drive_0.service_account_file;
  manifest.remotes.pop();
  assert.throws(()=>buildPendingImport(config,manifest),/MANIFEST_INVALID/);
  manifest.remotes.push({remote:'mega_1',rootId:'WRONG',displayName:'MEGA 1'});
  assert.throws(()=>buildPendingImport(config,manifest),/MEGA_ROOT_UNSUPPORTED/);
});
test('AES-GCM payload matches Dev v2 format and rejects wrong owner AAD',async()=>{
  const {buildPendingImport,sealForTenant}=await importer();
  const plan=buildPendingImport(...Object.values(fixture()));
  const key=Buffer.alloc(32,7),iv=Buffer.alloc(12,4);
  const id='9b67557e-cc56-4bac-8e3d-cdd2a5ed8ac2';
  const encrypted=Buffer.from(sealForTenant(owner,id,plan.rows[0].profile,key,iv),'base64');
  const open=(subject)=>{
    const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));
    decipher.setAAD(Buffer.from(JSON.stringify([subject,id,'google-drive','v2'])));
    decipher.setAuthTag(encrypted.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()])
      .toString('utf8'));
  };
  assert.equal(open(owner).token,plan.rows[0].profile.token);
  assert.throws(()=>open('oauth:google-oauth2|999999999'),/Unsupported state|authenticate/i);
});
function mockDb(existing=0, failInsert=false){
  const statements=[];let vault=0;let saved=0;let rollback=false;
  const client={
    async query(sql,args=[]){
      statements.push({sql,args});
      if(sql.startsWith('SELECT count(*)')&&sql.includes('nyx_connector_connections'))
        return {rows:[{n:existing}]};
      if(sql.startsWith('SELECT count(*)')&&sql.includes('nyx_rclone_tenant_credentials_v2'))
        return {rows:[{n:sql.includes("state='pending'")?vault:0}]};
      if(sql.startsWith('INSERT INTO nyx_connector_connections')){
        if(failInsert)throw Error('synthetic error with password redacted');
        saved++;
      }
      if(sql.startsWith('INSERT INTO nyx_rclone_tenant_credentials_v2'))vault++;
      if(sql==='ROLLBACK')rollback=true;
      return {rows:[],rowCount:1};
    },
    release(){}
  };
  return {db:{connect:async()=>client},statements,state:()=>({saved,vault,rollback})};
}
test('one transaction stages only pending, credential ciphertext and NO provider grants',async()=>{
  const {buildPendingImport,stageWithDb}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const ctx=mockDb();
  const result=await stageWithDb(ctx.db,plan,Buffer.alloc(32,8));
  assert.equal(result.status,'PENDING_ONLY_NO_PROVIDER_GRANTS');
  assert.equal(result.count,8);
  assert.deepEqual(ctx.state(),{saved:8,vault:8,rollback:false});
  assert.equal(ctx.statements.at(-1).sql,'COMMIT');
  const metadata=ctx.statements.filter(x=>x.sql.startsWith('INSERT INTO nyx_connector_connections'));
  const vault=ctx.statements.filter(x=>x.sql.startsWith('INSERT INTO nyx_rclone_tenant_credentials_v2'));
  assert.equal(metadata.length,8);
  for(let i=0;i<8;i++){
    assert.match(metadata[i].sql,/'pending'/);
    assert.match(metadata[i].sql,/'\[\]'::jsonb/);
    assert.equal(vault[i].args[0],owner);
    assert.ok(!JSON.stringify(vault[i].args).includes('fixture-token'));
    assert.ok(!JSON.stringify(metadata[i].args).includes('fixture-token'));
  }
});
test('existing owner connection blocks import and no partial staging survives',async()=>{
  const {buildPendingImport,stageWithDb}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const ctx=mockDb(1);
  await assert.rejects(stageWithDb(ctx.db,plan,Buffer.alloc(32,9)),/STAGING_FAILED/);
  assert.deepEqual(ctx.state(),{saved:0,vault:0,rollback:true});
});
test('failed row insertion rolls back, no activation is attempted',async()=>{
  const {buildPendingImport,stageWithDb}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const ctx=mockDb(0,true);
  await assert.rejects(stageWithDb(ctx.db,plan,Buffer.alloc(32,9)),/STAGING_FAILED/);
  assert.deepEqual(ctx.state(),{saved:0,vault:0,rollback:true});
});


test('all eight pending credentials activate atomically only after fresh Dev probes',async()=>{
  const {buildPendingImport,sealForTenant,finalizeReadVerified}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const key=Buffer.alloc(32,10),now=new Date('2026-11-16T14:00:00Z');
  const metadata=plan.rows.map((entry,i)=>({
    id:'aaaaaaaa-bbbb-4ccc-8ddd-'+String(i+1).padStart(12,'0'),
    display_name:entry.displayName,provider:entry.provider,status:'pending',
    external_account_id:'pending',capabilities:['storage:list'],
    provider_capabilities:[],resources:[{kind:entry.kind,id:entry.root,capabilities:['storage:list']}]
  }));
  const records=metadata.map((c,i)=>{
    const p={...plan.rows[i].profile};
    if(p.provider==='mega')p.verifiedRoot='MEGA_ROOT';
    return {connection_id:c.id,provider:c.provider,state:'pending',
      encrypted_profile:sealForTenant(owner,c.id,p,key),
      read_verified_at:new Date(now.getTime()-60000)};
  });
  const identities=metadata.map((row,i)=>({
    connection_id:row.id,owner_id:owner,provider:row.provider,
    external_id:row.provider==='mega'?plan.rows[i].profile.user:'verified-account-'+i,
    namespace:row.provider==='mega'
      ? 'mega-account:'+plan.rows[i].profile.user.toLowerCase()
      : plan.rows[i].profile.teamDriveId
        ? 'shared-drive:'+plan.rows[i].profile.teamDriveId
        : 'my-drive:verified-account-'+i,
  }));
  const count={metadata:0,vault:0,rollback:0,commit:0};
  const promotedIdentities=[];
  const client={
    async query(sql,args=[]){
      if(sql.startsWith('SELECT id,display_name'))return {rowCount:8,rows:metadata};
      if(sql.startsWith('SELECT connection_id,provider,encrypted_profile'))return {
        rowCount:8,rows:records};
      if(sql.startsWith('SELECT connection_id,owner_id,provider,namespace,external_id'))
        return {rowCount:8,rows:identities};
      if(sql.startsWith('UPDATE nyx_connector_connections')){
        count.metadata++;
        promotedIdentities.push(args[2]);
      }
      if(sql.startsWith('UPDATE nyx_rclone_tenant_credentials_v2'))count.vault++;
      if(sql==='ROLLBACK')count.rollback++;
      if(sql==='COMMIT')count.commit++;
      return {rowCount:1,rows:[]};
    },release(){}
  };
  const db={connect:async()=>client};
  const result=await finalizeReadVerified(db,plan,key,now);
  assert.equal(result.status,'ACTIVE_READ_VERIFIED_EIGHT');
  assert.equal(result.writeGrants,false);
  assert.deepEqual(count,{metadata:8,vault:8,rollback:0,commit:1});
  assert.deepEqual(promotedIdentities,identities.map(i=>i.external_id));
  records[0].read_verified_at=new Date(now.getTime()-16*60*1000);
  count.metadata=0;count.vault=0;count.commit=0;
  await assert.rejects(finalizeReadVerified(db,plan,key,now),/FINALIZE_FAILED/);
  assert.deepEqual(count,{metadata:0,vault:0,rollback:1,commit:0});
});
test('finalization rejects mismatched owner-bound ciphertext and unauthorized MEGA root',async()=>{
  const {buildPendingImport,sealForTenant,finalizeReadVerified}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const key=Buffer.alloc(32,5),now=new Date('2026-11-16T14:00:00Z');
  const rows=plan.rows.map((entry,i)=>({
    id:'bbbbbbbb-cccc-4ddd-8eee-'+String(i+1).padStart(12,'0'),
    display_name:entry.displayName,provider:entry.provider,status:'pending',
    external_account_id:'pending',capabilities:['storage:list'],
    provider_capabilities:[],resources:[{kind:entry.kind,id:entry.root,capabilities:['storage:list']}]
  }));
  const identities=rows.map((row,i)=>({
    connection_id:row.id,owner_id:owner,provider:row.provider,
    external_id:row.provider==='mega'?plan.rows[i].profile.user:'user-'+i,
    namespace:row.provider==='mega'
      ? 'mega-account:'+plan.rows[i].profile.user.toLowerCase()
      : plan.rows[i].profile.teamDriveId
        ? 'shared-drive:'+plan.rows[i].profile.teamDriveId
        : 'my-drive:user-'+i,
  }));
  const credentials=rows.map((c,i)=>({
    connection_id:c.id,provider:c.provider,state:'pending',
    encrypted_profile:sealForTenant('oauth:google-oauth2|999999999999',
      c.id,plan.rows[i].profile,key),
    read_verified_at:now
  }));
  let updates=0,rollbacks=0;
  const db={connect:async()=>({
    query:async(sql)=>{
      if(sql.startsWith('SELECT id,display_name'))return {rowCount:8,rows};
      if(sql.startsWith('SELECT connection_id,provider,encrypted_profile'))
        return {rowCount:8,rows:credentials};
      if(sql.startsWith('SELECT connection_id,owner_id,provider,namespace,external_id'))
        return {rowCount:8,rows:identities};
      if(sql.startsWith('UPDATE'))updates++;
      if(sql==='ROLLBACK')rollbacks++;
      return {rowCount:1,rows:[]};
    },release(){}
  })};
  await assert.rejects(finalizeReadVerified(db,plan,key,now),/FINALIZE_FAILED/);
  assert.equal(updates,0);
  assert.equal(rollbacks,1);
});


test('existing selected Shared Drive IDs stay encrypted while invalid IDs fail closed',async()=>{
  const {buildPendingImport,sealForTenant,openForTenant}=await importer();
  const {config,manifest}=fixture();
  const plan=buildPendingImport(config,manifest);
  assert.equal(plan.rows[1].profile.teamDriveId,'0A_shared_fixture_01');
  const key=Buffer.alloc(32,17),id='912548b7-78e1-4c23-8d2b-c6412ec5bbc1';
  const encrypted=sealForTenant(owner,id,plan.rows[1].profile,key);
  assert.ok(!encrypted.includes('0A_shared_fixture_01'));
  assert.equal(openForTenant(owner,id,'google-drive',encrypted,key).teamDriveId,
    '0A_shared_fixture_01');
  config.drive_1.team_drive='invalid/path';
  assert.throws(()=>buildPendingImport(config,manifest),/TEAM_DRIVE_INVALID/);
  config.drive_1.team_drive='0A_shared_fixture_01';
  config.drive_2.team_drive=42;
  assert.throws(()=>buildPendingImport(config,manifest),/TEAM_DRIVE_INVALID/);
});

test('finalization rejects eight read probes without independently attested identities',async()=>{
  const {buildPendingImport,sealForTenant,finalizeReadVerified}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const key=Buffer.alloc(32,19),now=new Date('2026-11-16T14:00:00Z');
  const rows=plan.rows.map((entry,i)=>({
    id:'cccccccc-dddd-4eee-8fff-'+String(i+1).padStart(12,'0'),
    display_name:entry.displayName,provider:entry.provider,status:'pending',
    external_account_id:'pending',capabilities:['storage:list'],
    provider_capabilities:[],resources:[{kind:entry.kind,id:entry.root,capabilities:['storage:list']}]
  }));
  const credentials=rows.map((c,i)=>({
    connection_id:c.id,provider:c.provider,state:'pending',
    encrypted_profile:sealForTenant(owner,c.id,{...plan.rows[i].profile,
      ...(c.provider==='mega'?{verifiedRoot:'MEGA_ROOT'}:{})},key),
    read_verified_at:now
  }));
  let updates=0,rollbacks=0;
  const db={connect:async()=>({
    query:async(sql)=>{
      if(sql.startsWith('SELECT id,display_name'))return {rowCount:8,rows};
      if(sql.startsWith('SELECT connection_id,provider,encrypted_profile'))
        return {rowCount:8,rows:credentials};
      if(sql.startsWith('SELECT connection_id,owner_id,provider,namespace,external_id'))
        return {rowCount:0,rows:[]};
      if(sql.startsWith('UPDATE'))updates++;
      if(sql==='ROLLBACK')rollbacks++;
      return {rowCount:1,rows:[]};
    },release(){}
  })};
  await assert.rejects(finalizeReadVerified(db,plan,key,now),/FINALIZE_FAILED/);
  assert.equal(updates,0);assert.equal(rollbacks,1);
});
