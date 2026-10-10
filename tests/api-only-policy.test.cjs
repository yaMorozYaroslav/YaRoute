const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ConnectorRegistry,
  CONNECTOR_CAPABILITIES,
  SELECTABLE_CONNECTOR_CAPABILITIES,
  supportsCapability,
} = require('../dist/connectors/connector-registry');
const { GitOperationPlanner } = require('../dist/connectors/git-operation-plan');
const { HerokuOperationPlanner } = require('../dist/connectors/heroku-operation-plan');

const legacy = {
  id: 'old', ownerId: 'oauth:me', provider: 'github',
  displayName: 'GitHub', externalAccountId: 'account',
  capabilities: ['git:push', 'git:inspect', 'ci:read'],
  providerCapabilities: ['git:push', 'git:inspect', 'ci:read'],
  resources: [{kind:'repository',id:'example/repo',
    capabilities:['git:push','git:inspect','ci:read']}],
  status: 'active',
};
const registry = new ConnectorRegistry({
  get: async id => id === legacy.id ? legacy : null,
  list: async () => [legacy],
  save: async () => {},
});

test('Git CLI capabilities are excluded from plugin options', () => {
  assert.ok(CONNECTOR_CAPABILITIES.includes('git:push'));
  assert.equal(SELECTABLE_CONNECTOR_CAPABILITIES.some(c => c.startsWith('git:')), false);
  assert.equal(supportsCapability('github', 'git:push'), false);
  assert.equal(supportsCapability('gitlab', 'git:inspect'), false);
  assert.equal(supportsCapability('github', 'ci:read'), true);
  assert.equal(supportsCapability('github', 'issues:read'), true);
});

test('legacy permissions cannot re-enable Git CLI execution', async () => {
  await assert.rejects(() => registry.require('oauth:me', 'old', 'git:inspect'), /CONNECTOR_FORBIDDEN/);
  await assert.rejects(() => registry.require('oauth:me', 'old', 'git:push'), /CONNECTOR_FORBIDDEN/);
  await assert.rejects(() => registry.setPermissions('oauth:me', 'old', ['git:push']),
    /CONNECTOR_PERMISSIONS_INVALID/);
  await assert.rejects(() => registry.setResources('oauth:me', 'old', legacy.resources),
    /CONNECTOR_RESOURCES_INVALID/);
  await registry.require('oauth:me', 'old', 'ci:read');
});

test('historical Git planner refuses to plan even with old grants', async () => {
  const planner = new GitOperationPlanner(registry);
  await assert.rejects(
    () => planner.plan('oauth:me', 'old', 'push', 'example/repo'),
    /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/,
  );
});

test('Heroku is Platform API only and financial operations stay blocked', async () => {
  assert.equal(supportsCapability('heroku', 'heroku:apps:read'), true);
  assert.equal(supportsCapability('heroku', 'heroku:apps:create'), false);
  const planner = new HerokuOperationPlanner(registry);
  await assert.rejects(
    () => planner.plan('oauth:me', 'old', 'app.create', 'example-app'),
    /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/,
  );
});
