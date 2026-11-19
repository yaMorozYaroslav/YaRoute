const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=path=>fs.readFileSync(require('node:path').join(root,path),'utf8');
const grant=read('src/connectors/connectors.service.ts');
const google=read('src/connectors/tenant-google-oauth.service.ts');
const storage=read('src/connectors/tenant-rclone.service.ts');
const api=read('src/mcp/mcp.service.ts');
const panel=read('src/connectors/connections-panel.ts');

test('Google Drive write access is explicit OAuth scope not a readonly token upgrade',()=>{
 assert.match(google,/DRIVE_WRITE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/drive'/);
 assert.match(google,/access === 'read-write' \? DRIVE_WRITE_SCOPE : DRIVE_READ_SCOPE/);
 assert.match(google,/granted\.has\(requestedAccess === 'read-write' \? DRIVE_WRITE_SCOPE : DRIVE_READ_SCOPE\)/);
 assert.match(google,/requestedAccess === 'read-write' && granted\.has\(DRIVE_WRITE_SCOPE\)/);
 assert.match(grant,/verifiedGoogleFullDrive &&/);
 assert.match(grant,/NYX_PUBLIC_GOOGLE_WRITE_ENABLED==='true'/);
});

test('Google Drive mutation is provider and owner authorized and uses recoverable trash',()=>{
 assert.match(storage,/NYX_PUBLIC_GOOGLE_WRITE_ENABLED!=='true'/);
 assert.match(storage,/TENANT_GOOGLE_FULL_SCOPE_REQUIRED/);
 assert.match(storage,/requireResource\(ownerId,connectionId,capability/);
 assert.match(storage,/--drive-use-trash=true/);
 assert.match(storage,/TENANT_GOOGLE_DESTINATION_EXISTS/);
 assert.match(storage,/nyx_rclone_google_mutations_v1/);
 assert.match(storage,/state='uncertain'/);
 assert.doesNotMatch(storage,/['\"]--drive-use-trash=false['\"]/);
 assert.match(api,/registerTool\('nyx_storage_google_file_mutate'/);
 assert.match(api,/process\.env\.NYX_PUBLIC_GOOGLE_WRITE_ENABLED === 'true'/);
});

test('bounded text writing is immutable and requires independent provider, root and owner grants',()=>{
 assert.match(storage,/async createTenantTextFile\(ownerId:string,connectionId:string/);
 assert.match(storage,/requireResource\(ownerId,connectionId,\s*'storage:write'/);
 assert.match(storage,/Buffer\.byteLength\(content,'utf8'\)>65536/);
 assert.match(storage,/\['copyto',input,'tenant:'\+target\.path,'--immutable'\]/);
 assert.match(storage,/nyx_rclone_tenant_creations_v1/);
 assert.match(api,/registerTool\('nyx_storage_text_file_create'/);
});

test('panel distinguishes requested per-root capability from verified provider consent',()=>{
 assert.match(panel,/Authorize Google Drive full access \(RW\)/);
 assert.match(panel,/Finish storage RW reauthorization/);
 assert.match(panel,/nyx_storage_connection_permissions/);
 assert.match(panel,/nyx_storage_connection_roots/);
 assert.match(panel,/permanent account-wide Trash cleanup is disabled unless separately enabled and confirmed/i);
});


test('fuller-permission selection uses server verified namespace and caller-owned connection',()=>{
 assert.match(storage,/selectBestAuthorizedConnection\(ownerId:string,connectionId:string/);
 assert.match(storage,/SELECT connection_id,owner_id,provider,namespace/);
 assert.match(storage,/selectVerifiedStorageConnection\(candidates/);
 assert.match(api,/registerTool\('nyx_storage_connection_select_best'/);
 assert.match(panel,/Use fullest authorized connection/);
 assert.match(panel,/operation:'storage:list'/);
});
