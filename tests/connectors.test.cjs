const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { GithubReadonlyConnector } = require('../dist/connectors/github-readonly');

const item = {
  id: 'conn1', ownerId: 'alice', displayName: 'Personal GitHub',
  provider: 'github', externalAccountId: 'org', installationId: '123',
  capabilities: ['ci:read','git:inspect'], providerCapabilities: ['ci:read', 'contents:write','git:inspect'],
  resources: [{kind:'repository',id:'org/repo',capabilities:['ci:read','git:inspect']}], status: 'active',
};
const repository = {
  get: async id => id === item.id ? { ...item, capabilities: [...item.capabilities] } : null,
  list: async () => [item],
  save: async () => {},
};

test('connector identity isolates tenants', async () => {
  const registry = new ConnectorRegistry(repository);
  await assert.rejects(() => registry.require('bob', 'conn1', 'ci:read'), /CONNECTOR_NOT_FOUND/);
  assert.deepEqual(await registry.list('bob'), []);
  await assert.rejects(() => registry.rename('bob', 'conn1', 'A'), /CONNECTOR_NOT_FOUND/);
  await assert.rejects(() => registry.setPermissions('bob', 'conn1', []), /CONNECTOR_NOT_FOUND/);
});
test('capability enforcement is fail closed', async () => {
  await assert.rejects(() => new ConnectorRegistry(repository).require('alice', 'conn1', 'contents:write'), /CONNECTOR_FORBIDDEN/);
});
test('user can rename a connection without changing its immutable identity or grants', async () => {
  let saved;
  const registry = new ConnectorRegistry({ ...repository, save: async c => { saved = c; } });
  const renamed = await registry.rename('alice', 'conn1', '  My personal projects  ');
  assert.equal(renamed.displayName, 'My personal projects');
  assert.equal(saved.id, item.id);
  assert.deepEqual(saved.providerCapabilities, item.providerCapabilities);
  await assert.rejects(() => registry.rename('alice', 'conn1', '  '), /CONNECTOR_NAME_INVALID/);
  await assert.rejects(() => registry.rename('alice', 'conn1', 'bad\nname'), /CONNECTOR_NAME_INVALID/);
});
test('user permissions cannot expand external provider grants', async () => {
  let saved;
  const registry = new ConnectorRegistry({ ...repository, save: async c => { saved = c; } });
  const result = await registry.setPermissions('alice', 'conn1', ['ci:read', 'ci:dispatch']);
  assert.deepEqual(saved.capabilities, ['ci:read', 'ci:dispatch']);
  assert.deepEqual(saved.providerCapabilities, item.providerCapabilities);
  assert.deepEqual(result.authorizationRequired, ['ci:dispatch']);
  await assert.rejects(
    () => new ConnectorRegistry({ ...repository, get: async () => saved }).require('alice', 'conn1', 'ci:dispatch'),
    /CONNECTOR_PROVIDER_PERMISSION_REQUIRED/,
  );
});
test('GitHub CI reads use owner-bound installation token', async () => {
  let url;
  const api = new GithubReadonlyConnector(new ConnectorRegistry(repository), {
    tokenFor: async (owner, id, installation) => {
      assert.deepEqual([owner, id, installation], ['alice', 'conn1', '123']);
      return 'test-token';
    },
  }, async (u, options) => {
    url = u;
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return { ok: true, json: async () => ({ workflow_runs: [] }) };
  });
  assert.deepEqual(await api.runs('alice', 'conn1', 'org/repo'), { workflow_runs: [] });
  assert.match(url, /\/actions\/runs\?/);
  await assert.rejects(() => api.runs('bob', 'conn1', 'org/repo'), /CONNECTOR_NOT_FOUND/);
  await assert.rejects(() => api.runs('alice', 'conn1', '../repo'), /GITHUB_REPOSITORY_INVALID/);
});

test('optional legacy labels suggested in order', () => {
  const { suggestConnectionName } = require('../dist/connectors/connector-registry');
  assert.equal(suggestConnectionName('google-drive', []), 'google_main');
  assert.equal(suggestConnectionName('google-drive', ['google_main']), 'google_work');
  assert.equal(suggestConnectionName('github', ['GitHub']), 'GitHub 2');
});

test('owner selected resource restricts GitHub access', async () => {
 const registry = new ConnectorRegistry(repository);
 await assert.rejects(() => registry.requireResource('alice','conn1','ci:read', {kind:'repository',id:'other/repo'}), /CONNECTOR_RESOURCE_FORBIDDEN/);
 let saved;
 const scoped = new ConnectorRegistry({...repository,save:async c=>{saved=c;}});
 await scoped.setResources('alice','conn1',[{kind:'repository',id:'org/repo',capabilities:['ci:read'],branches:['master']}]);
 assert.equal(saved.resources[0].branches[0],'master');
 await assert.rejects(() => new ConnectorRegistry({...repository,get:async()=>saved}).requireResource('alice','conn1','ci:read',{kind:'repository',id:'org/repo',branch:'dev'}), /CONNECTOR_RESOURCE_FORBIDDEN/);
});

test('Git planner never executes and checks scoped repository',async()=>{
 const {GitOperationPlanner}=require('../dist/connectors/git-operation-plan');
 const planner=new GitOperationPlanner(new ConnectorRegistry(repository));
 const plan=await planner.plan('alice','conn1','status','org/repo');
 assert.equal(plan.executable,false);
 await assert.rejects(()=>planner.plan('alice','conn1','status','someone/else'),/CONNECTOR_FORBIDDEN|CONNECTOR_RESOURCE_FORBIDDEN/);
});
test('Old Google names are optional suggestions',()=>{
 const {suggestConnectionName}=require('../dist/connectors/connector-registry');
 assert.equal(suggestConnectionName('google-drive',[]),'google_main');
 assert.equal(suggestConnectionName('google-drive',['google_main']),'google_work');
});
