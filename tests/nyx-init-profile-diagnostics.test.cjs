const test = require('node:test');
const assert = require('node:assert/strict');
const { NyxExecutionProfileService } = require('../dist/nyx/execution-profile.service');

const hash = 'a'.repeat(64);
const cli = { schema: 'nyx.cli.v1', version: 'test', commands: {} };
const valid = JSON.stringify({
  schema: 'nyx.runtime-profile.v1',
  authority: 'user-authorized-runtime-configuration',
  cliSha256: hash,
  commands: {},
  keySources: [],
});

test('malformed execution profile fails closed with a schema diagnostic', async () => {
  const service = new NyxExecutionProfileService({});
  await assert.rejects(service.applyText('{', cli, hash), {
    message: 'EXECUTION_PROFILE_SCHEMA_INVALID',
  });
  await assert.rejects(service.applyText('{"schema":"unknown"}', cli, hash), {
    message: 'EXECUTION_PROFILE_SCHEMA_INVALID',
  });
});

test('profile CLI mismatch is not silently accepted', async () => {
  const service = new NyxExecutionProfileService({});
  await assert.rejects(service.applyText(valid, cli, 'b'.repeat(64)), {
    message: 'PROFILE_AUTHORITY_CHANGED',
  });
});

test('a valid unpinned profile retains verified command bindings', async () => {
  const service = new NyxExecutionProfileService({});
  const applied = await service.applyText(valid, cli, hash);
  assert.deepEqual(applied.cli, { ...cli, commands: {} });
  assert.deepEqual(applied.keyReceipts, []);
  assert.deepEqual(applied.keyWarnings, []);
});

test('missing configured local profile fails closed without leaking its path', async () => {
  const previous = process.env.NYX_RUNTIME_PROFILE_PATH;
  process.env.NYX_RUNTIME_PROFILE_PATH = '/nonexistent/nyx-test-runtime-profile.json';
  try {
    const service = new NyxExecutionProfileService({});
    await assert.rejects(service.apply({}, cli, hash), {
      message: 'EXECUTION_PROFILE_FILE_UNAVAILABLE',
    });
  } finally {
    if (previous === undefined) delete process.env.NYX_RUNTIME_PROFILE_PATH;
    else process.env.NYX_RUNTIME_PROFILE_PATH = previous;
  }
});
