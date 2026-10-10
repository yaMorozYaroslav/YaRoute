const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PostgresConnectorRepository } = require('../dist/connectors/postgres-connector-repository');

const connection = {
  id: 'a', ownerId: 'oauth:alice', displayName: 'Research Drive',
  provider: 'google-drive', externalAccountId: 'account-1',
  capabilities: ['resources:read'], providerCapabilities: ['resources:read', 'contents:write'], status: 'pending',
};

test('connection metadata is persisted with owner-scoped upsert and user-chosen name', async () => {
  const queries = [];
  const repo = new PostgresConnectorRepository({ query: async (sql, values) => {
    queries.push({sql, values});
    return {rowCount: 1, rows: [{id: 'a'}]};
  }});
  await repo.initialize();
  await repo.save(connection);
  assert.match(queries.at(-1).sql, /WHERE nyx_connector_connections.owner_id=EXCLUDED.owner_id/);
  assert.equal(queries.at(-1).values[1], 'oauth:alice');
  assert.equal(queries.at(-1).values[2], 'Research Drive');
  assert.equal(queries.at(-1).values[7], '["resources:read","contents:write"]');
  assert.ok(queries.some(q => /UNIQUE INDEX/.test(q.sql) && /lower\(display_name\)/.test(q.sql)));
  assert.ok(queries.every(q => !JSON.stringify(q).includes('private_key')));
});
test('ownership conflicts reject writes', async () => {
  const repo = new PostgresConnectorRepository({query: async () => ({rowCount: 0, rows: []})});
  await assert.rejects(() => repo.save({...connection, ownerId: 'oauth:bob'}), /CONNECTOR_OWNER_CONFLICT/);
});
test('arbitrary connection names are accepted but control characters rejected', async () => {
  const repo = new PostgresConnectorRepository({query: async () => ({rowCount: 1, rows: []})});
  await repo.save({...connection, displayName: '📚 Research Drive — 2026'});
  await assert.rejects(() => repo.save({...connection, displayName: 'invalid\tname'}), /CONNECTOR_NAME_INVALID/);
});
