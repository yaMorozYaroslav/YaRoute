const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONNECTOR_CAPABILITIES, SELECTABLE_CONNECTOR_CAPABILITIES,
  ConnectorRegistry, supportsCapability,
} = require('../dist/connectors/connector-registry');
const {
  FINANCIAL_POLICY_VERSION, isFinanciallyProhibited, assertNoFinancialAccess,
  validateNonFinancialAction,
} = require('../dist/connectors/financial-safety');
const {
  HEROKU_OPERATIONS, HerokuOperationPlanner,
} = require('../dist/connectors/heroku-operation-plan');

const legacy = {
  id: 'legacy', ownerId: 'oauth:owner', displayName: 'Legacy Heroku',
  provider: 'heroku', externalAccountId: 'account', status: 'active',
  // Even historical fully granted capabilities must not bypass current policy.
  capabilities: ['heroku:apps:create', 'heroku:config:write', 'heroku:apps:read'],
  providerCapabilities: ['heroku:apps:create', 'heroku:config:write', 'heroku:apps:read'],
  resources: [
    { kind: 'heroku-account', id: 'owner', capabilities: ['heroku:apps:create'] },
    { kind: 'heroku-app', id: 'sample-app',
      capabilities: ['heroku:config:write', 'heroku:apps:read'] },
  ],
};
const repository = {
  get: async id => id === 'legacy' ? legacy : null,
  list: async () => [legacy],
  save: async () => {},
};

test('financial deny policy is non-overridable and keeps safe reads', async () => {
  assert.equal(FINANCIAL_POLICY_VERSION, 'nyx.financial-deny.v1');
  for (const action of [
    'heroku:apps:create', 'heroku:config:write',
    'heroku:formation:write', 'heroku:addons:write',
    'heroku:billing:read', 'heroku:payments:read',
    'subscription:renew', 'plan:upgrade', 'plans:change',
    'invoices:list', 'payment-method:add', 'pricing:tier',
    '/apps/sample-app/formation', '/account/billing',
    'purchase.subscription', 'addon:create',
  ]) {
    assert.equal(isFinanciallyProhibited(action), true, action);
    assert.throws(() => assertNoFinancialAccess(action),
      /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/, action);
  }
  for (const action of [
    'heroku:apps:read', 'heroku:releases:read',
    'heroku:config:names', 'git:inspect', 'git:commit', 'ci:read',
  ]) assert.equal(isFinanciallyProhibited(action), false, action);
  assert.equal(validateNonFinancialAction('git:inspect',['git:inspect']), 'git:inspect');
  assert.throws(() => validateNonFinancialAction('billing:read',['billing:read']),
    /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/);
});

test('UI never advertises financially prohibited capabilities', async () => {
  for (const capability of SELECTABLE_CONNECTOR_CAPABILITIES) {
    assert.equal(isFinanciallyProhibited(capability), false, capability);
  }
  assert.equal(CONNECTOR_CAPABILITIES.includes('heroku:apps:create'), true);
  assert.equal(SELECTABLE_CONNECTOR_CAPABILITIES.includes('heroku:apps:create'), false);
  assert.equal(SELECTABLE_CONNECTOR_CAPABILITIES.includes('heroku:config:write'), false);
  assert.equal(supportsCapability('heroku', 'heroku:apps:create'), false);
  assert.equal(supportsCapability('heroku', 'heroku:config:write'), false);
});

test('existing Heroku grants cannot authorize new paid apps or unrestricted secrets', async () => {
  const registry = new ConnectorRegistry(repository);
  for (const capability of ['heroku:apps:create', 'heroku:config:write']) {
    await assert.rejects(() => registry.require('oauth:owner', 'legacy', capability),
      /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/);
  }
  await assert.rejects(() => registry.setPermissions('oauth:owner','legacy',
    ['heroku:apps:create']), /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/);
  await assert.rejects(() => registry.setResources('oauth:owner','legacy',[
    {kind:'heroku-account',id:'owner',capabilities:['heroku:apps:create']},
  ]), /CONNECTOR_RESOURCES_INVALID/);
  await registry.require('oauth:owner', 'legacy', 'heroku:apps:read');
});

test('Heroku operation planner excludes creating apps, tariff modifications and billing', async () => {
  assert.equal(Object.hasOwn(HEROKU_OPERATIONS, 'app.create'), false);
  assert.equal(Object.hasOwn(HEROKU_OPERATIONS, 'config.set'), false);
  const planner = new HerokuOperationPlanner(new ConnectorRegistry(repository));
  for (const operation of [
    'app.create', 'config.set', 'app.plan', 'app.scale',
    'addon.create', 'billing.read', 'payment.update',
    'subscriptions.update', 'plan:upgrade',
  ]) {
    await assert.rejects(() => planner.plan('oauth:owner','legacy',operation,'sample-app'),
      /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/, operation);
  }
  const plan = await planner.plan('oauth:owner','legacy','app.info','sample-app');
  assert.equal(plan.executable,false);
});
