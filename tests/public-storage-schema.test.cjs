const test = require('node:test');
const assert = require('node:assert/strict');
const { PUBLIC_STORAGE_SCHEMA, resolvePublicStorageSlot } = require('../dist/storage/public-storage-schema.js');

test('public storage has exactly eight fixed slots', () => {
  assert.deepEqual(Object.keys(PUBLIC_STORAGE_SCHEMA).sort(), [
    'google_a', 'google_b', 'google_c', 'google_d', 'google_main', 'google_work',
    'mega_main', 'mega_work',
  ]);
});
test('main slots are read-only and work slots writable', () => {
  assert.equal(resolvePublicStorageSlot('google_main').access, 'read');
  assert.equal(resolvePublicStorageSlot('mega_main').access, 'read');
  assert.equal(resolvePublicStorageSlot('google_work').access, 'write');
  assert.equal(resolvePublicStorageSlot('mega_work').access, 'write');
});
test('unknown providers and slot injection are rejected', () => {
  for (const slot of ['dropbox', 'mega_a', '__proto__', 'constructor', 'google_main:other']) {
    assert.throws(() => resolvePublicStorageSlot(slot));
  }
});
