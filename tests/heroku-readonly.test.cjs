const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { HerokuReadonlyConnector } = require('../dist/connectors/heroku-readonly');

test('Heroku connector only reveals config key names for an approved app', async () => {
  const item = {
    id: 'heroku1', ownerId: 'oauth:owner', displayName: 'My Heroku',
    provider: 'heroku', externalAccountId: 'owner', status: 'active',
    capabilities: ['heroku:config:names'],
    providerCapabilities: ['heroku:config:names'],
    resources: [{
      kind: 'heroku-app', id: 'sample-app', capabilities: ['heroku:config:names'],
    }],
  };
  const registry = new ConnectorRegistry({
    get: async () => item, list: async () => [item], save: async () => {},
  });
  let calls = 0;
  const broker = {
    configNames: async (owner, connection, app) => {
      assert.deepEqual([owner, connection, app], ['oauth:owner', 'heroku1', 'sample-app']);
      calls++;
      return ['DATABASE_URL', 'PUBLIC_URL', 'PUBLIC_URL'];
    },
    appInfo: async () => { throw new Error('unavailable'); },
    releases: async () => { throw new Error('unavailable'); },
  };
  const connector = new HerokuReadonlyConnector(registry, broker);
  assert.deepEqual(await connector.configNames('oauth:owner', 'heroku1', 'sample-app'),
    ['DATABASE_URL', 'PUBLIC_URL']);
  assert.equal(calls, 1);
  await assert.rejects(() => connector.configNames('oauth:other', 'heroku1', 'sample-app'),
    /CONNECTOR_NOT_FOUND/);
  await assert.rejects(() => connector.configNames('oauth:owner', 'heroku1', 'other-app'),
    /CONNECTOR_RESOURCE_FORBIDDEN/);
  assert.equal(calls, 1);
});

test('Heroku config-name facade rejects broker response containing values', async () => {
  const item = {
    id: 'heroku1', ownerId: 'oauth:owner', displayName: 'My Heroku',
    provider: 'heroku', externalAccountId: 'owner', status: 'active',
    capabilities: ['heroku:config:names'],
    providerCapabilities: ['heroku:config:names'],
    resources: [{
      kind: 'heroku-app', id: 'sample-app', capabilities: ['heroku:config:names'],
    }],
  };
  const registry = new ConnectorRegistry({
    get: async () => item, list: async () => [item], save: async () => {},
  });
  const connector = new HerokuReadonlyConnector(registry, {
    configNames: async () => ({ DATABASE_URL: 'database-password' }),
    appInfo: async () => ({}), releases: async () => [],
  });
  await assert.rejects(() => connector.configNames('oauth:owner', 'heroku1', 'sample-app'),
    /HEROKU_RESPONSE_INVALID/);
});
