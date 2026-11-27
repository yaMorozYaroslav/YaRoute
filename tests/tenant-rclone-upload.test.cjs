const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TenantRcloneUploadService}=require('../dist/connectors/tenant-rclone-upload.service');
const {parseSelectedLocalRclone}=require('../dist/connectors/tenant-rclone-file-import');
const owner='oauth:google-oauth2|123456789012345678';
const id='a7c86541-298c-4bbe-8123-5d61bc220e11';
const demoToken=JSON.stringify({access_token:'fixture_access',refresh_token:'fixture_refresh'});
const file=['[ignored_remote]','type = sftp','pass = DO_NOT_IMPORT',
  '[drive_alpha]','type = drive','token = '+demoToken,
  '[mega_alpha]','type = mega','user = fixture_user','pass = fixture_obscured'].join('\n');

test('one local Rclone INI file selects only the requested Drive, not other remote secrets',()=>{
  const parsed=parseSelectedLocalRclone(file,'drive_alpha','google-drive','root');
  assert.equal(parsed.provider,'google-drive');
  assert.equal(parsed.token,demoToken);
  assert.equal(parsed.accountRoot,true);
  assert.equal(parsed.rootFolderId,'root');
  assert.ok(!JSON.stringify(parsed).includes('DO_NOT_IMPORT'));
  assert.ok(!JSON.stringify(parsed).includes('fixture_obscured'));
});
test('one selected MEGA profile includes only obscured password',()=>{
  const parsed=parseSelectedLocalRclone(file,'mega_alpha','mega','MEGA_ROOT');
  assert.equal(parsed.obscuredPassword,'fixture_obscured');
  assert.equal(parsed.user,'fixture_user');
  assert.ok(!JSON.stringify(parsed).includes('fixture_refresh'));
});
test('unknown options, duplicate keys, mismatched provider/root and oversized input fail closed',()=>{
  assert.throws(()=>parseSelectedLocalRclone(file,'drive_alpha','google-drive','another'),/ROOT_MISMATCH/);
  assert.throws(()=>parseSelectedLocalRclone(file,'mega_alpha','google-drive','root'),/PROVIDER_MISMATCH/);
  assert.throws(()=>parseSelectedLocalRclone(file,'mega_alpha','mega','WRONG'),/MEGA_ROOT_UNSUPPORTED/);
  assert.throws(()=>parseSelectedLocalRclone(file.replace('[drive_alpha]','[drive_alpha]\nconfig = /secrets'),
    'drive_alpha','google-drive','root'),/OPTION_UNSUPPORTED/);
  assert.throws(()=>parseSelectedLocalRclone(file.replace('type = drive','type = drive\ntype = drive'),
    'drive_alpha','google-drive','root'),/FORMAT_INVALID/);
  assert.throws(()=>parseSelectedLocalRclone(file+'\\n'.repeat(70000),
    'drive_alpha','google-drive','root'),/FILE_INVALID/);
  assert.throws(()=>parseSelectedLocalRclone(file,'ignored_remote','mega','MEGA_ROOT'),/PROVIDER_MISMATCH/);
});
test('upload state binds to signed owner and exact pending connection; returns no secrets',async()=>{
  let stateRow, deleted=false, staged=[], probed=[];
  const connectors={getOwned:async(actor,key)=>{
    if(actor!==owner||key!==id)throw Error('OWNER_FORBIDDEN');
    return {id,ownerId:owner,provider:'google-drive',status:'pending',
      resources:[{kind:'drive',id:'root',capabilities:['storage:list']}]};
  }};
  const storage={stageCredential:async(...args)=>staged.push(args),
    probePending:async(...args)=>{probed.push(args);return 'verified';}};
  const svc=new TenantRcloneUploadService(connectors,storage);
  svc.pool={query:async(sql,args=[])=>{
    if(sql.startsWith('INSERT')){stateRow={digest:args[0],owner:args[1],
      connection:args[2],provider:args[3],root:args[4]};return {rowCount:1};}
    if(sql.startsWith('SELECT digest'))return {rowCount:deleted?0:1};
    if(sql.startsWith('DELETE')&&sql.includes('RETURNING')){
      if(deleted)return {rowCount:0};
      assert.equal(args[0],stateRow.digest);
      deleted=true;
      return {rowCount:1,rows:[{owner_id:stateRow.owner,
        connection_id:stateRow.connection,provider:stateRow.provider,root_id:stateRow.root}]};
    }
    return {rowCount:1};
  }};
  const old=process.env.NYX_PUBLIC_URL;
  process.env.NYX_PUBLIC_URL='https://nestnyx.example.invalid';
  try{
    const link=await svc.begin(owner,id);
    const state=new URL(link.url).searchParams.get('state');
    assert.equal(new URL(link.url).pathname,'/connect/rclone/import');
    assert.equal(await svc.canDisplay(state),true);
    await assert.rejects(svc.begin('oauth:google-oauth2|999999999999999',id),/OWNER_FORBIDDEN/);
    const outcome=await svc.complete(state,'drive_alpha',file);
    assert.equal(outcome.status,'pending_activation');
    assert.equal(staged.length,1);
    assert.equal(staged[0][0],owner);
    assert.equal(staged[0][1],id);
    assert.equal(staged[0][2].token,demoToken);
    assert.deepEqual(probed,[[owner,id]]);
    assert.ok(!JSON.stringify(outcome).includes('fixture_access'));
    await assert.rejects(svc.complete(state,'drive_alpha',file),/EXPIRED/);
  }finally{
    if(old===undefined)delete process.env.NYX_PUBLIC_URL;
    else process.env.NYX_PUBLIC_URL=old;
  }
});
