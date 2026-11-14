const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const runtime=fs.readFileSync(path.join(root,'src/connectors/tenant-rclone.service.ts'),'utf8');
const api=fs.readFileSync(path.join(root,'src/mcp/mcp.service.ts'),'utf8');
const grant=fs.readFileSync(path.join(root,'src/connectors/connectors.service.ts'),'utf8');
const ui=fs.readFileSync(path.join(root,'src/connectors/connections-panel.ts'),'utf8');

test('MEGA mutation is public-only, opt-in and never uses private/global Rclone',()=>{
 assert.match(runtime,/process\.env\.NYX_DEPLOYMENT_MODE!=='public'/);
 assert.match(runtime,/process\.env\.NYX_PUBLIC_MEGA_WRITE_ENABLED!=='true'/);
 assert.match(runtime,/await this\.authorizedTarget\(ownerId,connectionId,'mega',rootId,source\)/);
 assert.match(runtime,/policy\.requireResource\(ownerId,connectionId,scope/);
 assert.match(runtime,/fs\.mkdtemp\(path\.join\(os\.tmpdir\(\),'nyx-tenant-mega-write-'\)\)/);
 assert.match(runtime,/fs\.writeFile\(cfg,tenantRcloneConfig\(target\.profile\),\{mode:0o600,flag:'wx'\}\)/);
 assert.doesNotMatch(runtime,/\[.*'purge'.*\]/);
});
test('Single-file rubbish-bin deletion never hard-deletes and requires no second approval',()=>{
 assert.match(runtime,/--mega-hard-delete=false/);
 assert.match(runtime,/await run\(\['deletefile','tenant:'\+target\.path\]\)/);
 assert.match(runtime,/operation==='trash'\?'mega-provider-rubbish-bin':null/);
 assert.match(runtime,/confirmationRequired:false/);
 assert.match(api,/registerTool\('nyx_storage_mega_file_mutate'/);
 assert.match(api,/destructiveHint:true/);
 assert.match(ui,/Delete to trash/);
 assert.match(ui,/mutate\('trash'\)/);
 assert.doesNotMatch(ui,/confirm\([^\n]*Delete to trash/);
});
test('Move/rename is confined to one exact root and does not overwrite',()=>{
 assert.match(runtime,/TENANT_MEGA_RENAME_PARENT_CHANGED/);
 assert.match(runtime,/TENANT_MEGA_DESTINATION_EXISTS/);
 assert.match(runtime,/TENANT_MEGA_DUPLICATE_PATH/);
 assert.match(runtime,/TENANT_MEGA_FILES_ONLY/);
 assert.match(runtime,/--ignore-existing/);
 assert.match(runtime,/TENANT_MEGA_NOOP_FORBIDDEN/);
 assert.match(runtime,/pg_advisory_lock/);
 assert.match(runtime,/nyx_rclone_mega_mutations_v1/);
 assert.match(runtime,/state='uncertain'/);
});
test('Write grants require separate flag, user-selected capability, and provider reauthorization',()=>{
 assert.match(grant,/connection\.provider==='mega' &&\s*process\.env\.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true'/);
 assert.match(grant,/\['storage:list','storage:move','storage:delete'\]/);
 assert.match(ui,/Reauthorize MEGA for writes/);
 assert.match(ui,/Save file permissions/);
 assert.match(api,/process\.env\.NYX_PUBLIC_MEGA_WRITE_ENABLED === 'true'/);
});
