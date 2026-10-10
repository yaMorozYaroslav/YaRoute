const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PostgresConnectorRepository } = require('../dist/connectors/postgres-connector-repository');

test('connection metadata is persisted with owner-scoped upsert', async () => {
  const queries = [];
  const repo = new PostgresConnectorRepository({ query: async (sql, values) => {
    queries.push({sql,values});
    return {rowCount:1,rows:[{id:'a'}]};
  }});
  await repo.initialize();
  await repo.save({id:'a',ownerId:'oauth:alice',provider:'github',externalAccountId:'org',installationId:'42',capabilities:['ci:read'],status:'pending'});
  assert.match(queries.at(-1).sql,/WHERE nyx_connector_connections.owner_id=EXCLUDED.owner_id/);
  assert.equal(queries.at(-1).values[1], 'oauth:alice');
  assert.ok(queries.every(q => !JSON.stringify(q).includes('private_key')));
});
test('ownership conflicts reject writes', async () => {
  const repo = new PostgresConnectorRepository({query:async()=>({rowCount:0,rows:[]})});
  await assert.rejects(() => repo.save({id:'a',ownerId:'oauth:bob',provider:'github',externalAccountId:'org',capabilities:[],status:'pending'}),/CONNECTOR_OWNER_CONFLICT/);
});
