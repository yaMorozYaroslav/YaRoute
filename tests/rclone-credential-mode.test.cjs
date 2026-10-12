const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {PostgresConnectorRepository}=require('../dist/connectors/postgres-connector-repository');

test('private legacy remotes remain distinct from owner-encrypted accounts as vault flag changes',async t=>{
 const prev=process.env.NYX_DEPLOYMENT_MODE;
 const oldPublic=process.env.NYX_PUBLIC_CONNECTORS_ENABLED;
 t.after(()=>{if(prev===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
   else process.env.NYX_DEPLOYMENT_MODE=prev;
   if(oldPublic===undefined)delete process.env.NYX_PUBLIC_CONNECTORS_ENABLED;
   else process.env.NYX_PUBLIC_CONNECTORS_ENABLED=oldPublic;});
 process.env.NYX_DEPLOYMENT_MODE='private';
 const rows=new Map(),probes=[];
 let vaultOn=true;
 const storage={
   rcloneConnections:async()=>({remotes:[{provider:'google-drive',name:'legacy_drive'}]}),
   testRcloneConnection:async(provider,name)=>{
     probes.push('private:'+name);
     return {schema:'nyx.storage.rclone.probe.v1',provider,name,status:'reachable',configurationChanged:false};
   },
   testIsolatedRcloneConnection:async(provider,name,profile)=>{
     assert.equal(profile,'[nyx_new]\\ntype = drive\\n');
     probes.push('vault:'+name);
     return {schema:'nyx.storage.rclone.probe.v1',provider,name,status:'reachable',configurationChanged:false};
   },
 };
 const vault={isEnabled:()=>vaultOn,load:async()=> '[nyx_new]\\ntype = drive\\n'};
 const repo={
   get:async id=>rows.get(id)??null,
   list:async owner=>[...rows.values()].filter(row=>row.ownerId===owner),
   save:async row=>{rows.set(row.id,{...row});},
 };
 const svc=new ConnectorsService(storage,vault);
 svc.repository=repo;svc.registry=new ConnectorRegistry(repo);
 svc.pool={query:async()=>({rows:[],rowCount:1})};
 const legacy=await svc.createRclone('oauth:owner','google-drive','legacy_drive','Legacy',true);
 const fresh=await svc.createRclone('oauth:owner','google-drive','nyx_new','Fresh');
 assert.equal(legacy.connectionType,'private-rclone-reference');
 assert.equal(fresh.connectionType,'isolated-credential-vault');
 assert.equal((await svc.testRclone('oauth:owner',legacy.id)).status,'reachable');
 assert.equal((await svc.testRclone('oauth:owner',fresh.id)).status,'reachable');
 assert.deepEqual(probes,['private:legacy_drive','vault:nyx_new']);
 vaultOn=false;
 assert.equal(svc.view(rows.get(legacy.id)).connectionType,'private-rclone-reference');
 assert.equal(svc.view(rows.get(fresh.id)).connectionType,'isolated-credential-vault');
 await assert.rejects(()=>svc.testRclone('oauth:owner',fresh.id),/RCLONE_VAULT_NOT_CONFIGURED/);
 assert.equal((await svc.testRclone('oauth:owner',legacy.id)).status,'reachable');
 await assert.rejects(()=>svc.beginGoogleDrive('oauth:owner',legacy.id),/RCLONE_VAULT_NOT_CONFIGURED/);
 vaultOn=true;
 await assert.rejects(()=>svc.beginGoogleDrive('oauth:owner',legacy.id),/GOOGLE_CONNECTION_UNAVAILABLE/);
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 const visible=await svc.list('oauth:owner');
 assert.deepEqual(visible.map(x=>x.id),[fresh.id]);
 await assert.rejects(()=>svc.testRclone('oauth:owner',legacy.id),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
 await assert.rejects(()=>svc.createRclone('oauth:owner','google-drive','legacy_drive','Unsafe',true),/PUBLIC_RCLONE_VAULT_REQUIRED|PRIVATE_RCLONE_CONNECTIONS_ONLY/);
});

test('credential mode migration defaults historical rows to private and persists new vault mode',async()=>{
 const sql=[];
 const repo=new PostgresConnectorRepository({query:async(s,args=[])=>{
   sql.push({s,args});
   return {rowCount:1,rows:[]};
 }});
 await repo.initialize();
 assert.ok(sql.some(x=>x.s.includes("credential_mode text NOT NULL DEFAULT 'private-rclone-reference'")));
 const record={
  id:'123e4567-e89b-42d3-a456-426614174000',ownerId:'oauth:owner',provider:'google-drive',
  displayName:'New account',externalAccountId:'nyx_new',status:'pending',
  credentialMode:'isolated-credential-vault',
  capabilities:[],providerCapabilities:[],resources:[],
 };
 await repo.save(record);
 const insert=sql.find(x=>x.s.includes('INSERT INTO nyx_connector_connections'));
 assert.ok(insert.s.includes('credential_mode'));
 assert.equal(insert.args.at(-1),'isolated-credential-vault');
});
