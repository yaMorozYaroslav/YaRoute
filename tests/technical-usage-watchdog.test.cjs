const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessTechnicalUsage } = require('../dist/connectors/technical-usage-watchdog');

test('normal bounded usage is not a financial guarantee', () => {
  const a = assessTechnicalUsage({ signal: 'ci-runs', count: 1, windowMinutes: 60 });
  assert.equal(a.verdict, 'normal');
  assert.match(a.message, /not a guarantee of zero cost/);
  assert.equal(a.billingDataUsed, false);
});
test('CI bursts produce proactive warnings without reading billing information', () => {
  const a = assessTechnicalUsage({ signal: 'ci-runs', count: 5, windowMinutes: 60 });
  assert.equal(a.verdict, 'warn');
  assert.equal(a.mustNotify, true);
  assert.equal(a.freezeAutomations, false);
  const b = assessTechnicalUsage({ signal: 'ci-runs', count: 13, windowMinutes: 60 });
  assert.equal(b.verdict, 'freeze-and-warn');
  assert.equal(b.freezeAutomations, true);
});
test('repeated failed deploys and large transfer detect delayed exposure', () => {
  assert.equal(assessTechnicalUsage({signal:'failed-deployments',count:3,windowMinutes:60}).freezeAutomations,true);
  assert.equal(assessTechnicalUsage({signal:'bytes-transferred',count:2*1024**3,windowMinutes:60}).freezeAutomations,true);
  assert.equal(assessTechnicalUsage({signal:'storage-growth-bytes',count:1024**3,windowMinutes:1440}).verdict,'warn');
});
test('invalid or unknown usage counters fail closed', () => {
  for(const input of [
    {signal:'ci-runs',count:-1,windowMinutes:60},
    {signal:'ci-runs',count:NaN,windowMinutes:60},
    {signal:'ci-runs',count:1,windowMinutes:0},
    {signal:'unknown',count:1,windowMinutes:60},
  ]) {
    const a=assessTechnicalUsage(input);
    assert.equal(a.freezeAutomations,true);
    assert.equal(a.mustNotify,true);
  }
});
