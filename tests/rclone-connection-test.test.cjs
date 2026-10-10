const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { StorageService } = require('../dist/storage/storage.service');

const originalMode = process.env.NYX_DEPLOYMENT_MODE;
function restoreMode() {
  if (originalMode === undefined) delete process.env.NYX_DEPLOYMENT_MODE;
  else process.env.NYX_DEPLOYMENT_MODE = originalMode;
}
function setup(probe = async () => ({ stdout: '{}', stderr: '' })) {
  const calls = [];
  const rclone = {
    listRemoteNamesByType: async type => type === 'drive' ? ['drive_main'] : ['mega_main'],
    run: async args => { calls.push(args); return probe(args); },
  };
  const roots = {
    listAreas: () => ['MAIN'],
    get: () => ({ remote: 'drive_main', root: 'secret/root', token: 'must-stay-private' }),
  };
  return { service: new StorageService(roots, rclone), calls };
}
test('probe checks only an existing private Drive or MEGA remote without reading paths or updating config', async t => {
  t.after(restoreMode);
  process.env.NYX_DEPLOYMENT_MODE = 'private';
  const { service, calls } = setup();
  const result = await service.testRcloneConnection('google-drive', 'drive_main');
  assert.deepEqual(result, {
    schema: 'nyx.storage.rclone.probe.v1', provider: 'google-drive',
    name: 'drive_main', status: 'reachable', check: 'rclone_about',
    configurationChanged: false,
  });
  assert.deepEqual(calls, [['about', 'drive_main:', '--json', '--contimeout', '5s', '--timeout', '12s']]);
  assert.equal(JSON.stringify(result).includes('secret/root'), false);
  await service.testRcloneConnection('mega', 'mega_main');
  assert.equal(calls.length, 2);
});
test('probe rejects unconfigured names, malformed names and public multi-user mode', async t => {
  t.after(restoreMode);
  process.env.NYX_DEPLOYMENT_MODE = 'private';
  const { service, calls } = setup();
  await assert.rejects(() => service.testRcloneConnection('mega', 'drive_main'), /RCLONE_REMOTE_NOT_CONFIGURED/);
  await assert.rejects(() => service.testRcloneConnection('mega', '--config'), /RCLONE_REMOTE_INVALID/);
  assert.deepEqual(calls, []);
  process.env.NYX_DEPLOYMENT_MODE = 'public';
  await assert.rejects(() => service.testRcloneConnection('mega', 'mega_main'), /PRIVATE_RCLONE_CONNECTIONS_ONLY/);
  assert.deepEqual(calls, []);
});
test('unsupported or failing probes do not expose provider errors and never claim availability', async t => {
  t.after(restoreMode);
  process.env.NYX_DEPLOYMENT_MODE = 'private';
  const { service } = setup(async () => { throw Error('private-token-and-provider-details'); });
  const result = await service.testRcloneConnection('mega', 'mega_main');
  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'PROBE_FAILED_OR_UNSUPPORTED');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
test('Rclone probe stays private and app-only; panel renders results as text', () => {
  const mcp = fs.readFileSync(path.join(__dirname, '../src/mcp/mcp.service.ts'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '../src/connectors/connections-panel.ts'), 'utf8');
  assert.ok(mcp.indexOf("server.registerTool('nyx_rclone_connection_test'") >
    mcp.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;"));
  assert.match(mcp, /this\.storage\.testRcloneConnection\(provider,name\)/);
  assert.match(mcp, /visibility:\['app'\]/);
  assert.match(panel, /Test access/);
  assert.match(panel, /nyx_rclone_connection_test/);
  assert.match(panel, /checkStatus\.textContent/);
});