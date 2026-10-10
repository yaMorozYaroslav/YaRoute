const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLegacyKey, appendLegacyProposals } = require('../dist/nyx/key-legacy');
const sample = 'NYX KEY TEMP — oF\n\nPrioritized active keys\n1. [HIGH] Keep provenance.\n2. [MEDIUM] Check bootstrap.\n\nCurrent verified state\n- Do not erase me.\n';
test('legacy KEY parser recognizes active entries', () => {
 const parsed = parseLegacyKey(sample);
 assert.equal(parsed.items.length, 2);
 assert.equal(parsed.items[0].description, 'Keep provenance.');
 assert.equal(parsed.items[0].blocked, true);
});
test('legacy proposal staging preserves every original byte', () => {
 const result = appendLegacyProposals(sample, [{id:'proposal',target:'head',description:'Update CLI',confidence:0.9,source:'chat'}], 'tx1');
 assert.ok(result.startsWith(sample));
 assert.match(result, /Current verified state/);
 assert.match(result, /Pending KEY proposals/);
});
test('malformed legacy content fails closed', () => {
 assert.throws(() => parseLegacyKey('not a KEY'), /KEY_LEGACY_SECTION_MISSING/);
});
