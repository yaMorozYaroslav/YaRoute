const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const id='11111111-2222-4333-8444-555555555555',alice='oauth:alice';
const profile={provider:'mega',user:['fake','invalid.test'].join('@'),obscuredPassword:'synthetic-obscured'};
function fixture(){
 const calls=[];
 const connection={ownerId:alice,id,status:'active',provider:'mega',
   capabilities:['storage:list'],providerCapabilities:['storage:list'],
   resources:[{kind:'mega-root',id:'MyDocuments',capabilities:['storage:list']}]};
 const connectors={
   getOwned:async(owner,connId)=>{
     if(owner!==alice || connId!==id) throw Error('OTHER_TENANT');
     return connection;
   },
   registryPolicy:()=>({requireResource:async(owner,connId,capability,r)=>{
     if(owner!==alice||connId!==id||capability!=='storage:list'||
        r.kind!=='mega-root'||r.id!=='MyDocuments')throw Error('UNAUTHORIZED_ROOT');
     return connection;
   }}),
 };
 const svc=new TenantRcloneService(connectors);
 svc.profile=async()=>({provider:'mega',profile:{...profile,verifiedRoot:'MyDocuments'}});
 svc.probe=async(_p,relative)=>{calls.push(relative);return 'verified';};
 return {svc,calls};
}
test('active MEGA connection verifies only the selected root and relative subtree',async()=>{
 const {svc,calls}=fixture();
 assert.equal(await svc.probeAuthorizedRoot(alice,id,'mega','MyDocuments','Family'),
   'verified');
 assert.deepEqual(calls,['MyDocuments/Family']);
});
test('active probe denies foreign owner and a different account root without storage reads',async()=>{
 const {svc,calls}=fixture();
 await assert.rejects(()=>svc.probeAuthorizedRoot('oauth:bob',id,'mega','MyDocuments'),
   /TENANT_RCLONE_CONNECTION_FORBIDDEN/);
 await assert.rejects(()=>svc.probeAuthorizedRoot(alice,id,'mega','AnotherRoot'),
   /UNAUTHORIZED_ROOT/);
 await assert.rejects(()=>svc.probeAuthorizedRoot(alice,id,'mega','MyDocuments','../outside'),
   /TENANT_RCLONE_PATH_INVALID/);
 assert.equal(calls.length,0);
});
test('new MCP test-active route is owner-scoped, guarded and read only',()=>{
 const mcp=readFileSync('src/mcp/mcp.service.ts','utf8');
 const start=mcp.indexOf("server.registerTool('nyx_storage_connection_test_active'");
 assert.ok(start>0);
 const route=mcp.slice(start,mcp.indexOf('    // Public multi-user connector mode',start));
 assert.match(route,/this\.tenantRclone\.probeAuthorizedRoot/);
 assert.match(route,/this\.connectorOwner\(\)/);
 assert.match(route,/readOnlyHint:true/);
 assert.doesNotMatch(route,/credentials|password|token:|legacyConfig/i);
 const multi=mcp.indexOf("process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true'");
 assert.ok(multi>=0 && multi<start);
});
