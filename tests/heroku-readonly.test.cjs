const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {HerokuReadonlyConnector}=require('../dist/connectors/heroku-readonly');

test('Heroku only reveals config variable names for a permitted app',async()=>{
 const item={id:'heroku1',ownerId:'oauth:owner',displayName:'My Heroku',
 provider:'heroku',externalAccountId:'owner',status:'active',
 capabilities:['heroku:config:names'],providerCapabilities:['heroku:config:names'],
 resources:[{kind:'heroku-app',id:'sample-app',capabilities:['heroku:config:names']}]};
 const registry=new ConnectorRegistry({
   get:async()=>item,list:async()=>[item],save:async()=>{}
 });
 let calls=0;
 const connector=new HerokuReadonlyConnector(registry,{
   tokenFor:async()=>{calls++;return 'mock-only';}
 },async()=>({ok:true,json:async()=>({DATABASE_URL:'sensitive',PUBLIC_URL:'public'})}));
 assert.deepEqual(await connector.configNames('oauth:owner','heroku1','sample-app'),['DATABASE_URL','PUBLIC_URL']);
 assert.equal(calls,1);
 await assert.rejects(()=>connector.configNames('oauth:other','heroku1','sample-app'),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>connector.configNames('oauth:owner','heroku1','other-app'),/CONNECTOR_RESOURCE_FORBIDDEN/);
 assert.equal(calls,1);
});
