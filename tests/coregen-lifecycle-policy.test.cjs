const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(
  join(__dirname, '..', 'src', 'nyx', 'coregen-lifecycle.policy.ts'),
  'utf8',
);

test('HeartBit/CoreGen policy creates a seed at five decent unresolved keys', () => {
  assert.match(source, /adaptiveKeySeedThreshold:\s*5/);
  assert.match(source, /five decent unresolved keys/);
  assert.match(source, /explicitGlobalSeedCommand:\s*'NyxkeyoSG'/);
});

test('one compatible seed can make one core generation ready', () => {
  assert.match(source, /minimumCompatibleSeedsForCoreGeneration:\s*1/);
  assert.match(source, /deferredWarningsBlockGeneration:\s*false/);
  assert.match(source, /autoRepairDeterministicPipelineFaults:\s*true/);
});

test('Template is explicit exception while core recoverability remains mandatory', () => {
  assert.match(source, /templateIsRecoverabilityException:\s*true/);
  assert.match(source, /coreBundleRecoverabilityRequired:\s*true/);
});

test('Footer compaction cadence is six and next successful generation is forced', () => {
  assert.match(source, /footerCompactionEveryUpdates:\s*6/);
  assert.match(source, /forceFooterCompactionOnNextSuccessfulCoreGeneration:\s*true/);
});
