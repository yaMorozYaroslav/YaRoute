const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectorsService } = require('../dist/connectors/connectors.service');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { PostgresConnectorRepository } = require('../dist/connectors/postgres-connector-repository');

const previous = process.env.NYX_DEPLOYMENT_MODE;
function restore() {
  if (previous === undefined) delete process.env.NYX_DEPLOYMENT_MODE;
  else process.env.NYX_DEPLOYMENT_MODE = previous;
}
function fixture() {
  const rows = new Map();
  const calls = [];
  const storage = {
    rcloneConnections: async () => ({
      remotes: [
        { provider: 'google-drive', name: 'drive_one' },
        { provider: 'google-drive', name: 'drive_two' },
        { provider: 'mega', name: 'mega_one' },
      ],
    }),
    testRcloneConnection: async (provider,name) => {
      calls.push({ provider, name });
      return { schema: 'nyx.storage.rclone.probe.v1', provider, name,
        status: 'reachable', configurationChanged: false };
    },
  };
  const repo = {
    get: async id => rows.get(id) ?? null,
    list: async ownerId => [...rows.values()].filter(c => c.ownerId === ownerId),
    save: async c => {
      if ([...rows.values()].some(other => other.id !== c.id &&
          other.ownerId === c.ownerId && other.displayName.toLowerCase() === c.displayName.toLowerCase())) {
        throw Error('DUPLICATE_NAME');
      }
      rows.set(c.id, { ...c });
    },
  };
  const service = new ConnectorsService(storage);
  service.repository = repo;
  service.registry = new ConnectorRegistry(repo);
  service.pool = { query: async (sql, args) => {
    if (sql.includes("SET status='revoked'")) {
      const row = rows.get(args[0]);
      if (row && row.ownerId === args[1]) rows.set(row.id, { ...row, status: 'revoked' });
    }
    return { rowCount: 1, rows: [] };
  }};
  return { service, rows, calls };
}
test('one OAuth owner can link multiple Drive and MEGA accounts with different stable IDs', async t => {
  t.after(restore);
  process.env.NYX_DEPLOYMENT_MODE = 'private';
  const { service } = fixture();
  const a = await service.createRclone('oauth:alice', 'google-drive', 'drive_one', 'Personal');
  const b = await service.createRclone('oauth:alice', 'google-drive', 'drive_two', 'Work');
  const c = await service.createRclone('oauth:alice', 'mega', 'mega_one', 'Archive');
  assert.equal(new Set([a.id,b.id,c.id]).size, 3);
  assert.deepEqual((await service.list('oauth:alice')).map(x=>x.displayName).sort(), ['Archive','Personal','Work']);
  assert.deepEqual([a,b,c].map(x=>x.status), ['pending','pending','pending']);
  assert.ok([a,b,c].every(x=>!x.providerCapabilities.length && !x.capabilities.length && !x.resources.length));
  assert.ok([a,b,c].every(x=>x.configurationChanged===false));
});
test('OAuth subjects are isolated; linked account IDs never authorize another owner', async t => {
  t.after(restore);
  process.env.NYX_DEPLOYMENT_MODE = 'private';
  const { service, calls } = fixture();
  const alice=await service.createRclone('oauth:alice','mega','mega_one','Personal Mega');
  const bob=await service.createRclone('oauth:bob','mega','mega_one','Bob Mega');
  assert.notEqual(alice.id,bob.id);
  assert.equal((await service.list('oauth:alice')).length,1);
  assert.equal((await service.list('oauth:bob')).length,1);
  await assert.rejects(()=>service.testRclone('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
  await assert.rejects(()=>service.rename('oauth:bob',alice.id,'Stolen'),/CONNECTOR_NOT_FOUND/);
  await assert.rejects(()=>service.disconnect('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
  assert.deepEqual(calls,[]);
  const probe=await service.testRclone('oauth:alice',alice.id);
  assert.equal(probe.connectionId,alice.id);
  assert.deepEqual(calls,[{provider:'mega',name:'mega_one'}]);
});
test('unlinked and invalid remote entries cannot be tested or registered', async t => {
  t.after(restore);
  process.env.NYX_DEPLOYMENT_MODE='private';
  const {service,calls}=fixture();
  await assert.rejects(()=>service.createRclone('oauth:alice','mega','drive_one','Wrong provider'),/RCLONE_REMOTE_NOT_CONFIGURED/);
  await assert.rejects(()=>service.createRclone('oauth:alice','mega','--config','Invalid'),/RCLONE_REMOTE_INVALID/);
  const linked=await service.createRclone('oauth:alice','google-drive','drive_one','Personal');
  await assert.rejects(()=>service.createRclone('oauth:alice','google-drive','drive_one','Duplicate'),/RCLONE_REMOTE_ALREADY_LINKED/);
  const renamed=await service.rename('oauth:alice',linked.id,'Renamed Personal');
  assert.equal(renamed.displayName,'Renamed Personal');
  const disconnected=await service.disconnect('oauth:alice',linked.id);
  assert.equal(disconnected.metadataOnly,true);
  assert.equal(disconnected.configurationChanged,false);
  await assert.rejects(()=>service.testRclone('oauth:alice',linked.id),/RCLONE_CONNECTION_NOT_AVAILABLE/);
  assert.deepEqual(calls,[]);
});
test('public mode cannot bind or probe private process-global Rclone remotes', async t => {
  t.after(restore);
  process.env.NYX_DEPLOYMENT_MODE='private';
  const {service}=fixture();
  const linked=await service.createRclone('oauth:alice','mega','mega_one','Archive');
  process.env.NYX_DEPLOYMENT_MODE='public';
  assert.deepEqual(await service.list('oauth:alice'),[]);
  await assert.rejects(()=>service.createRclone('oauth:alice','mega','mega_one','Other'),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
  await assert.rejects(()=>service.testRclone('oauth:alice',linked.id),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
  await assert.rejects(()=>service.disconnect('oauth:alice',linked.id),/CONNECTOR_PROVIDER_DISABLED/);
});
test('PostgreSQL migration preserves multi-account rows and enforces an owner-scoped remote uniqueness index', async()=>{
  const sql=[];
  const repo=new PostgresConnectorRepository({query:async s=>{sql.push(s);return {rowCount:1,rows:[]};}});
  await repo.initialize();
  assert.ok(sql.some(s=>s.includes('nyx_rclone_owner_remote_uq') &&
    s.includes('owner_id, provider, external_account_id') &&
    s.includes("status <> 'revoked'")));
  assert.ok(sql.some(s=>s.includes('nyx_connector_owner_name_uq')));
  assert.ok(sql.every(s=>!s.includes('DROP TABLE')));
});
