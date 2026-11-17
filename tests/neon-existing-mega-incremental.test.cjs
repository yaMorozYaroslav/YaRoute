const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const importer=()=>import(pathToFileURL(path.resolve('scripts/nyx-neon-owner-rclone-import.mjs')).href);
const owner='oauth:google-oauth2|123456789012345678';
const uuid=i=>'cccccccc-cccc-4ccc-8ccc-'+String(i).padStart(12,'0');
function fixture(){
  const config={},manifest={ownerId:owner,remotes:[]};
  for(let i=0;i<6;i++){
    const remote='drive_'+i;
    config[remote]={type:'drive',token:JSON.stringify({access_token:'test-access-'+i,
      refresh_token:'test-refresh-'+i})};
    manifest.remotes.push({remote,displayName:'Drive '+i,rootId:'root'});
  }
  for(let i=0;i<2;i++){
    const remote='mega_'+i;
    config[remote]={type:'mega',user:'test'+i+'@example.org',pass:'test-obscured-'+i};
    manifest.remotes.push({remote,displayName:'MEGA '+i,rootId:'MEGA_ROOT'});
  }
  return {config,manifest};
}
function baseline(plan,includePending=true){
  const mega=plan.rows.filter(r=>r.provider==='mega').map((r,i)=>({
    id:uuid(20+i),display_name:r.displayName,provider:'mega',status:'active',
    external_account_id:r.profile.user,resources:[{kind:'mega-root',id:'MEGA_ROOT',
      capabilities:['storage:list']}],
    capabilities:['storage:list'],provider_capabilities:['storage:list'],
  }));
  const pending=includePending?[{id:uuid(30),display_name:'Drive 0',
    provider:'google-drive',status:'pending',external_account_id:'pending',
    capabilities:['storage:list'],provider_capabilities:[],
    resources:[{kind:'drive',id:'root',capabilities:['storage:list']}]}]:[];
  const vault=mega.map(c=>({connection_id:c.id,provider:'mega',state:'active'}));
  vault.push({connection_id:mega[0].id,provider:'mega',state:'pending'});
  return {mega,pending,vault};
}
test('incremental stage preserves existing MEGA metadata and pending rotation',async()=>{
  const {buildPendingImport,stageSixWithExistingMega}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const old=baseline(plan);const queries=[];let drives=0;
  const db={connect:async()=>({query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.startsWith('SELECT id,display_name,provider'))return {rows:[...old.mega,...old.pending]};
    if(sql.startsWith('SELECT connection_id,provider,state FROM'))return {rows:old.vault};
    if(sql.startsWith('INSERT INTO nyx_connector_connections'))return {rowCount:1};
    if(sql.startsWith('INSERT INTO nyx_rclone_tenant_credentials_v2')){drives++;return {rowCount:1};}
    if(sql.startsWith('SELECT count(*)::int AS n'))return {rows:[{n:drives}]};
    return {rowCount:1,rows:[]};
  },release(){}})};
  const result=await stageSixWithExistingMega(db,plan,Buffer.alloc(32,8),()=>uuid(50+drives));
  assert.equal(result.count,6);
  assert.equal(result.megaModified,false);
  assert.equal(drives,6);
  assert.equal(queries.filter(x=>x.sql.startsWith('INSERT INTO nyx_connector_connections')).length,5);
  assert.equal(queries.filter(x=>x.sql==='COMMIT').length,1);
  assert.equal(queries.filter(x=>x.sql.startsWith('UPDATE')).length,0);
  assert.ok(queries.filter(x=>x.sql.startsWith('INSERT INTO nyx_rclone_tenant_credentials_v2'))
    .every(x=>!JSON.stringify(x.args).includes('test-access-')));
});
test('incremental stage rolls back if pending Drive root changes',async()=>{
  const {buildPendingImport,stageSixWithExistingMega}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const old=baseline(plan);
  old.pending[0].resources[0].id='unexpected-root';
  let rolls=0,inserted=0;
  const db={connect:async()=>({query:async(sql)=>{
    if(sql.startsWith('SELECT id,display_name,provider'))return {rows:[...old.mega,...old.pending]};
    if(sql.startsWith('SELECT connection_id,provider,state FROM'))return {rows:old.vault};
    if(sql==='ROLLBACK')rolls++;
    if(sql.startsWith('INSERT'))inserted++;
    return {rowCount:1,rows:[]};
  },release(){}})};
  await assert.rejects(stageSixWithExistingMega(db,plan,Buffer.alloc(32,3)),/SIX_DRIVE_STAGE_ROLLED_BACK/);
  assert.equal(rolls,1);
  assert.equal(inserted,0);
});
test('finalize six fresh Google Drive proofs and leave both active MEGAs unchanged',async()=>{
  const {buildPendingImport,sealForTenant,finalizeSixWithExistingMega}=await importer();
  const {config,manifest}=fixture(),plan=buildPendingImport(config,manifest);
  const key=Buffer.alloc(32,9),now=new Date('2026-11-17T16:00:00Z');
  const base=baseline(plan,false);
  const google=plan.rows.filter(x=>x.provider==='google-drive').map((entry,i)=>({
    id:uuid(40+i),display_name:entry.displayName,provider:'google-drive',
    status:'pending',external_account_id:'pending',capabilities:['storage:list'],
    provider_capabilities:[],resources:[{kind:'drive',id:entry.root,capabilities:['storage:list']}],
  }));
  const credentialRows=[...base.vault,...google.map((c,i)=>({
    connection_id:c.id,provider:'google-drive',state:'pending',
    encrypted_profile:sealForTenant(owner,c.id,plan.rows[i].profile,key),
    read_verified_at:new Date(now.getTime()-60000),
  }))];
  const identities=google.map((c,i)=>({connection_id:c.id,owner_id:owner,
    provider:'google-drive',namespace:'my-drive:verified-'+i,external_id:'verified-'+i}));
  const changed=[];let commits=0,rolls=0;
  const db={connect:async()=>({query:async(sql,args=[])=>{
    if(sql.startsWith('SELECT id,display_name,provider'))return {rowCount:8,rows:[...base.mega,...google]};
    if(sql.startsWith('SELECT connection_id,provider,state,encrypted_profile'))return {rows:credentialRows};
    if(sql.startsWith('SELECT connection_id,owner_id,provider'))return {rowCount:6,rows:identities};
    if(sql.startsWith('UPDATE'))changed.push({sql,args});
    if(sql==='COMMIT')commits++;
    if(sql==='ROLLBACK')rolls++;
    return {rowCount:1,rows:[]};
  },release(){}})};
  const result=await finalizeSixWithExistingMega(db,plan,key,now);
  assert.equal(result.count,6);
  assert.equal(result.megaModified,false);
  assert.equal(result.writeGrants,false);
  assert.equal(changed.length,12);
  assert.ok(changed.every(x=>x.sql.includes("provider='google-drive'")));
  assert.equal(commits,1);
  credentialRows.find(x=>x.provider==='google-drive').read_verified_at=
    new Date(now.getTime()-20*60*1000);
  changed.length=0;commits=0;
  await assert.rejects(finalizeSixWithExistingMega(db,plan,key,now),/FINALIZE_SIX_DRIVES_ROLLED_BACK/);
  assert.equal(changed.length,0);
  assert.equal(commits,0);
  assert.equal(rolls,1);
});
