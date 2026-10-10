const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessPotentialFinancialLoss,
  assertEligibleForAutonomousExecution,
} = require('../dist/connectors/financial-risk-preflight');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { GitOperationPlanner } = require('../dist/connectors/git-operation-plan');
const { HerokuOperationPlanner } = require('../dist/connectors/heroku-operation-plan');

function preview(provider, operation, overrides = {}) {
  return assessPotentialFinancialLoss({ provider, operation, ...overrides });
}
test('financial operations cannot be approved or downgraded by a warning', () => {
  for (const operation of [
    'billing.read', 'payment:checkout', 'heroku:app.create',
    'heroku:app.scale', 'heroku:config.set',
    'neon:project.create', 'neon:compute.resize', 'cloud:resource.create',
  ]) {
    const a = preview('heroku', operation);
    assert.equal(a.decision, 'deny', operation);
    assert.equal(a.severity, 'forbidden', operation);
    assert.equal(a.mustNotify, true);
    assert.equal(a.mayRunAutonomously, false);
    assert.throws(() => assertEligibleForAutonomousExecution(a),
      /NYX_FINANCIAL_RISK_REQUIRES_MANUAL_REVIEW/);
  }
});

test('unrecognized operations fail closed and alert', () => {
  const a = preview('heroku', 'arbitrary-shell-execute');
  assert.equal(a.decision, 'deny');
  assert.equal(a.severity, 'unknown');
  assert.ok(a.warnings.some(x => /cannot be ruled out/i.test(x)));
});

test('Git push warns about CI, indirect ongoing usage and requires review', () => {
  const a = preview('github', 'git:push');
  assert.equal(a.decision, 'warn-and-hold');
  assert.equal(a.severity, 'high');
  assert.equal(a.mustNotify, true);
  assert.equal(a.actualCostUnknown, true);
  assert.ok(a.categories.includes('automation-trigger'));
  assert.ok(a.categories.includes('recurring-consumption'));
  assert.throws(() => assertEligibleForAutonomousExecution(a));
});

test('deployment and security-related diffs receive extra warning', () => {
  const a = preview('github','git:push',{
    paths: ['src/readme.ts', '.github/workflows/ci.yml',
      'src/connectors/financial-safety.ts'],
  });
  assert.equal(a.decision, 'warn-and-hold');
  assert.ok(a.categories.includes('credential-exposure'));
  assert.ok(a.prerequisites.some(x => /complete diff outside NYX/.test(x)));
});

test('cross-cloud transfers and deletes detect financial and recovery risk', () => {
  const transfer = preview('google-drive', 'storage:copy', {
    crossProvider: true, estimatedBytes: 2 * (1024 ** 3),
  });
  assert.equal(transfer.severity, 'high');
  assert.ok(transfer.categories.includes('network-egress'));
  assert.ok(transfer.categories.includes('storage-growth'));
  const deletion = preview('mega', 'storage:delete');
  assert.equal(deletion.decision, 'warn-and-hold');
  assert.ok(deletion.categories.includes('data-loss'));
  assert.ok(deletion.prerequisites.some(x => /verified backup/.test(x)));
});

test('automated work and high-volume provider calls cannot run silently', () => {
  const read = preview('google-drive', 'storage:list');
  assert.equal(read.decision, 'allow-low-risk-read');
  assert.equal(read.mayRunAutonomously, true);
  assert.doesNotThrow(() => assertEligibleForAutonomousExecution(read));
  const burst = preview('google-drive', 'storage:list', {
    estimatedCalls: 500, recurring: true,
  });
  assert.equal(burst.decision, 'warn-and-hold');
  assert.equal(burst.severity, 'high');
  assert.ok(burst.categories.includes('api-usage'));
  assert.ok(burst.categories.includes('recurring-consumption'));
});

test('invalid estimates or unbounded file manifest fail closed', () => {
  assert.equal(preview('github', 'git:push', {estimatedCalls: -1}).decision, 'deny');
  assert.equal(preview('github', 'git:push', {estimatedBytes: Number.POSITIVE_INFINITY}).decision, 'deny');
  assert.equal(preview('github', 'git:push', {paths: ['a'.repeat(2050)]}).decision, 'deny');
});

function registry(connection) {
  return new ConnectorRegistry({
    get: async id => id === connection.id ? connection : null,
    list: async () => [connection],
    save: async () => {},
  });
}

test('Git operation plans include risk warnings and remain nonexecutable', async () => {
  const github = registry({
    id:'g', ownerId:'oauth:user', displayName:'Repo', provider:'github',
    externalAccountId:'someone', status:'active',
    capabilities:['git:inspect','git:push'],
    providerCapabilities:['git:inspect','git:push'],
    resources:[{kind:'repository',id:'team/service',
      capabilities:['git:inspect','git:push']}],
  });
  const planner = new GitOperationPlanner(github);
  await assert.rejects(
    () => planner.plan('oauth:user','g','push','team/service'),
    /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/,
  );
  await assert.rejects(
    () => planner.plan('oauth:user','g','status','team/service'),
    /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/,
  );
  const apiRisk = preview('github', 'git:push');
  assert.equal(apiRisk.decision, 'warn-and-hold');
});

test('Heroku deployment plans include warnings and never authorize billing actions', async () => {
  const heroku = registry({
    id:'h', ownerId:'oauth:user', displayName:'Runtime', provider:'heroku',
    externalAccountId:'user', status:'active',
    capabilities:['heroku:apps:read','heroku:deploy'],
    providerCapabilities:['heroku:apps:read','heroku:deploy'],
    resources:[{kind:'heroku-app',id:'safe-service',
      capabilities:['heroku:apps:read','heroku:deploy']}],
  });
  const planner = new HerokuOperationPlanner(heroku);
  const deploy = await planner.plan('oauth:user','h','app.deploy','safe-service');
  assert.equal(deploy.financialRisk.severity, 'high');
  assert.equal(deploy.financialRisk.actualCostUnknown, true);
  assert.equal(deploy.executable, false);
  await assert.rejects(
    () => planner.plan('oauth:user','h','app.create','safe-service'),
    /NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN/,
  );
});
