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

test('MCP-facing GitHub connector service rejects pending write/CI execution features',async()=>{
 const {service,id}=svcFor('github');
 for(const permission of ['ci:dispatch','contents:write','pulls:write','issues:write',
  'releases:write','git:push']){
  await assert.rejects(()=>service.permissions('oauth:alice',id,[permission]),
    /CONNECTOR_API_CAPABILITY_NOT_READY/);
 }
 await assert.rejects(()=>service.resources('oauth:alice',id,[{
  kind:'repository',id:'someone/repo',capabilities:['contents:write'],
 }]),/CONNECTOR_API_CAPABILITY_NOT_READY/);
 const result=await service.permissions('oauth:alice',id,['resources:read']);
 assert.deepEqual(result.authorizationRequired,['resources:read']);
 assert.equal(result.status,'active');
 assert.equal(result.availableCapabilities.includes('ci:dispatch'),false);
});

test('MCP-facing Heroku connector service refuses deployment, scale and secret edits',async()=>{
 const {service,id}=svcFor('heroku');
 for(const permission of ['heroku:deploy','heroku:apps:restart',
  'heroku:config:write','heroku:apps:create']){
  await assert.rejects(()=>service.permissions('oauth:alice',id,[permission]),
    /CONNECTOR_API_CAPABILITY_NOT_READY/);
 }
 const view=await service.permissions('oauth:alice',id,['heroku:apps:read']);
 assert.ok(view.availableCapabilities.includes('heroku:apps:read'));
 assert.equal(view.availableCapabilities.includes('heroku:deploy'),false);
});
