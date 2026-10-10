const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');

function svcFor(provider){
 const connection={
  id:'11111111-1111-4111-8111-111111111111',ownerId:'oauth:alice',
  displayName:'Production-safety',provider,externalAccountId:'verified',
  status:'active',installationId:provider==='github'?'123':undefined,
  capabilities:[],providerCapabilities:[],resources:[],
 };
 const repo={
  get:async id=>id===connection.id?connection:null,
  list:async()=>[connection],
  save:async updated=>Object.assign(connection,updated),
 };
 const service=new ConnectorsService();
 service.pool={query:async()=>({rowCount:1,rows:[]})};
 service.repository=repo;
 service.registry=new ConnectorRegistry(repo);
 return {service,id:connection.id,connection};
}

test('MCP-facing GitHub exposes only reviewed API writes, never CI dispatch or Git CLI',async()=>{
 const {service,id,connection}=svcFor('github');
 for(const permission of ['ci:dispatch','releases:write','git:push']){
  await assert.rejects(()=>service.permissions('oauth:alice',id,[permission]),
    /CONNECTOR_API_CAPABILITY_NOT_READY/);
 }
 const requested=['resources:read','contents:write','pulls:write','issues:write'];
 const result=await service.permissions('oauth:alice',id,requested);
 assert.deepEqual(result.authorizationRequired,requested);
 assert.equal(result.status,'active');
 assert.equal(result.availableCapabilities.includes('contents:write'),true);
 assert.equal(result.availableCapabilities.includes('pulls:write'),true);
 assert.equal(result.availableCapabilities.includes('issues:write'),true);
 assert.equal(result.availableCapabilities.includes('ci:dispatch'),false);
 assert.equal(result.availableCapabilities.includes('releases:write'),false);
 assert.ok(connection.capabilities.includes('contents:write'));
 const resource=await service.resources('oauth:alice',id,[{
  kind:'repository',id:'someone/repo',capabilities:['contents:write','pulls:write'],
 }]);
 assert.equal(resource.resources[0].id,'someone/repo');
 await assert.rejects(()=>service.resources('oauth:alice',id,[{
  kind:'repository',id:'someone/repo',capabilities:['ci:dispatch'],
 }]),/CONNECTOR_API_CAPABILITY_NOT_READY/);
});

test('Legacy Heroku connector rows stay inert, not exposed in live GitHub-only MCP',async()=>{
 const {service,id}=svcFor('heroku');
 await assert.rejects(()=>service.create('oauth:alice','heroku','Blocked'),
   /CONNECTOR_PROVIDER_NOT_READY/);
 await assert.rejects(()=>service.rename('oauth:alice',id,'Blocked'),
   /CONNECTOR_PROVIDER_DISABLED/);
 await assert.rejects(()=>service.permissions('oauth:alice',id,['heroku:apps:read']),
   /CONNECTOR_PROVIDER_DISABLED/);
 await assert.rejects(()=>service.resources('oauth:alice',id,[]),
   /CONNECTOR_PROVIDER_DISABLED/);
 await assert.rejects(()=>service.consumeQuota('oauth:alice',id),
   /CONNECTOR_PROVIDER_DISABLED/);
 await assert.rejects(()=>service.disconnect('oauth:alice',id),
   /CONNECTOR_PROVIDER_DISABLED/);
 assert.deepEqual(await service.list('oauth:alice'),[]);
});
