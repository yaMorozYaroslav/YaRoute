const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const owner='oauth:alice',id='12345678-1234-4234-8234-123456789abc';
function setup({failAt=0,provider='mega'}={}){
 const sql=[],record={ownerId:owner,id,status:'active',provider,
  resources:[{kind:'mega-root',id:'MyDocuments',capabilities:['storage:list']}]};
 const svc=new TenantRcloneService({getOwned:async(actor,connectionId)=>{
  if(actor!==owner||connectionId!==id)throw Error('CONNECTOR_NOT_FOUND');
  return record;
 }});
 svc.encryptionKey=Buffer.alloc(32,7);
 const client={
  query:async(query,params)=>{
   sql.push({query,params});
   if(failAt===sql.length)throw Error('DATABASE_WRITE_FAILED');
   return {rowCount:1,rows:[{id}]};
  },release:()=>sql.push({query:'RELEASE'})
 };
 svc.pool={connect:async()=>client};
 return {svc,sql};
}
test('revoking a MEGA owner connection atomically disables the grant and clears credentials + pending enrollment',async()=>{
 const {svc,sql}=setup();
 const r=await svc.revokeStorage(owner,id);
 assert.deepEqual(r,{id,status:'revoked',localCredentialsDeleted:true,externalRevocationRequired:true});
 const statements=sql.map(x=>x.query);
 assert.equal(statements[0],'BEGIN');
 assert.match(statements[1],/UPDATE nyx_connector_connections SET status='revoked'/);
 assert.match(statements[1],/owner_id=\$1 AND id=\$2 AND provider IN \('mega','google-drive'\)/);
 assert.match(statements[1],/capabilities='\[\]'::jsonb/);
 assert.match(statements[2],/DELETE FROM nyx_rclone_tenant_credentials_v2/);
 assert.match(statements[3],/DELETE FROM nyx_rclone_mega_enroll_states_v2/);
 assert.match(statements[4],/DELETE FROM nyx_rclone_google_oauth_states_v2/);
 assert.equal(statements[5],'COMMIT');
 assert.equal(statements[6],'RELEASE');
 for(const query of sql.slice(1,5))assert.deepEqual(query.params,[owner,id]);
 assert.equal(statements.some(s=>/DELETE FROM nyx_connector_connections/.test(s)),false);
});
test('different OAuth owner or connection ID cannot trigger any database transaction',async()=>{
 const {svc,sql}=setup();
 await assert.rejects(()=>svc.revokeStorage('oauth:bob',id),/CONNECTION_FORBIDDEN/);
 await assert.rejects(()=>svc.revokeStorage(owner,'11111111-1111-4111-8111-111111111111'),/CONNECTION_FORBIDDEN/);
 assert.deepEqual(sql,[]);
});
test('revocation rolls back if deleting encrypted data fails; no partial successful acknowledgement',async()=>{
 const {svc,sql}=setup({failAt:3});
 await assert.rejects(()=>svc.revokeStorage(owner,id),/DATABASE_WRITE_FAILED/);
 assert.equal(sql.some(x=>x.query==='COMMIT'),false);
 assert.deepEqual(sql.slice(-2).map(x=>x.query),['ROLLBACK','RELEASE']);
});
test('public MCP tool requires authenticated owner and exposes only connection ID',()=>{
 const s=readFileSync('src/mcp/mcp.service.ts','utf8');
 const start=s.indexOf("server.registerTool('nyx_storage_connection_revoke'");
 const end=s.indexOf("server.registerTool('nyx_storage_connection_test_active'",start);
 assert.ok(start>0&&end>start);
 const block=s.slice(start,end);
 assert.match(block,/this\.tenantRclone\.revokeStorage\(this\.connectorOwner\(\),id\)/);
 assert.match(block,/destructiveHint:true/);
 assert.match(block,/inputSchema:z\.object\(\{id:z\.string\(\)\.uuid\(\)\}\)/);
 assert.doesNotMatch(block,/password|token|masterKey|user:|ownerId:/);
 const gate=s.lastIndexOf("if (process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true'",start);
 assert.ok(gate>0&&gate<start);
 assert.match(s,/['"]nyx_storage_connection_revoke['"]/);
});
