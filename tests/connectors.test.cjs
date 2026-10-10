const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { GithubReadonlyConnector } = require('../dist/connectors/github-readonly');

const item = { id:'conn1', ownerId:'alice', provider:'github', externalAccountId:'org', installationId:'123', capabilities:['ci:read'], status:'active' };
const repository = { get: async id => id === item.id ? item : null, list: async () => [item], save: async () => {} };
test('connector identity isolates tenants', async () => {
  const registry = new ConnectorRegistry(repository);
  await assert.rejects(() => registry.require('bob','conn1','ci:read'), /CONNECTOR_NOT_FOUND/);
  assert.deepEqual(await registry.list('bob'), []);
});
test('capability enforcement is fail closed', async () => {
  await assert.rejects(() => new ConnectorRegistry(repository).require('alice','conn1','contents:write'), /CONNECTOR_FORBIDDEN/);
});
test('GitHub CI reads use owner-bound installation token', async () => {
  let url;
  const api = new GithubReadonlyConnector(new ConnectorRegistry(repository), {
    tokenFor: async (owner, id, installation) => {
      assert.deepEqual([owner,id,installation], ['alice','conn1','123']);
      return 'test-token';
    },
  }, async (u, options) => {
    url = u;
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return { ok:true, json:async()=>({workflow_runs:[]}) };
  });
  assert.deepEqual(await api.runs('alice','conn1','org/repo'), {workflow_runs:[]});
  assert.match(url, /\/actions\/runs\?/);
  await assert.rejects(() => api.runs('bob','conn1','org/repo'), /CONNECTOR_NOT_FOUND/);
  await assert.rejects(() => api.runs('alice','conn1','../repo'), /GITHUB_REPOSITORY_INVALID/);
});
