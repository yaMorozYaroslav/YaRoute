const {test} = require('node:test');
const assert = require('node:assert/strict');

const modulePath = require.resolve('../dist/connectors/connections-panel');
const vars = ['NYX_DEPLOYMENT_MODE', 'NYX_PUBLIC_CONNECTORS_ENABLED',
  'NYX_MULTIUSER_RCLONE_ENABLED'];

function renderPanel(mode, connectors, multiuser) {
  const saved = Object.fromEntries(vars.map(name => [name, process.env[name]]));
  try {
    process.env.NYX_DEPLOYMENT_MODE = mode;
    process.env.NYX_PUBLIC_CONNECTORS_ENABLED = connectors;
    process.env.NYX_MULTIUSER_RCLONE_ENABLED = multiuser;
    delete require.cache[modulePath];
    return require(modulePath).CONNECTIONS_PANEL_HTML;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[modulePath];
  }
}

test('signed-in public tenants discover their own Rclone onboarding at startup', () => {
  const html = renderPanel('public', 'true', 'true');
  assert.match(html, /const publicTenantStorage=true;/);
  assert.match(html, /if\(publicTenantStorage\)refreshTenantStorage\(\);\s*else refreshRclone\(\);/);
  assert.match(html, /call\('nyx_storage_connections_list',\{\}\)/);
  assert.match(html, /call\('nyx_storage_connection_create',\{provider,name\}\)/);
  assert.match(html, /nyx_storage_connection_begin_google/);
  assert.match(html, /nyx_storage_connection_begin_mega/);
  assert.match(html, /nyx_storage_connection_list_files/);
  assert.match(html, /id="nyx-google-count"/);
  assert.match(html, /nyx-'\+label\+'-count/);
});

test('public tenant UI does not offer legacy operator Rclone inventory', () => {
  const html = renderPanel('public', 'true', 'true');
  assert.match(html, /data-open="nyx-rclone-group" hidden/);
  assert.match(html, /id="nyx-rclone-group" hidden/);
  assert.match(html, /Other users and private legacy remotes remain inaccessible/);
});

test('private mode preserves operator Rclone inventory without enabling tenant onboarding', () => {
  const html = renderPanel('private', 'false', 'false');
  assert.match(html, /const publicTenantStorage=false;/);
  assert.match(html, /data-open="nyx-rclone-group"\s*>/);
  assert.match(html, /id="nyx-rclone-group"\s*>/);
  assert.doesNotMatch(html, /id="nyx-rclone-group" hidden/);
});

test('disabled public storage flags do not falsely advertise tenant onboarding', () => {
  for (const [connectors, multiuser] of [['false','true'],['true','false']]) {
    const html = renderPanel('public', connectors, multiuser);
    assert.match(html, /const publicTenantStorage=false;/);
  }
});
