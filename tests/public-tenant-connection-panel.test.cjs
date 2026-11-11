const {test} = require('node:test');
const assert = require('node:assert/strict');

const modulePath = require.resolve('../dist/connectors/connections-panel');
const vars = ['NYX_DEPLOYMENT_MODE', 'NYX_PUBLIC_CONNECTORS_ENABLED',
  'NYX_MULTIUSER_RCLONE_ENABLED','NYX_PRIVATE_OWNER_LINK_ENABLED','NYX_PRIVATE_BROKER_CLIENT_ENABLED'];

function renderPanel(mode, connectors, multiuser, ownerLink = 'false', brokerClient = 'false') {
  const saved = Object.fromEntries(vars.map(name => [name, process.env[name]]));
  try {
    process.env.NYX_DEPLOYMENT_MODE = mode;
    process.env.NYX_PUBLIC_CONNECTORS_ENABLED = connectors;
    process.env.NYX_MULTIUSER_RCLONE_ENABLED = multiuser;
    process.env.NYX_PRIVATE_OWNER_LINK_ENABLED = ownerLink;
    process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED = brokerClient;
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
  assert.match(html, /if\(publicTenantStorage\)\{\s*refreshTenantStorage\(\);\s*if\(ownerLinkEnabled\)refreshOwnerLink\(\);\s*\}else refreshRclone\(\);/);
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

test('owner verification is opt-in and displayed only after authenticated eligibility', () => {
  const html = renderPanel('public','true','true','true');
  assert.match(html,/const ownerLinkEnabled=true;/);
  assert.match(html,/id="nyx-private-owner-group" hidden/);
  assert.match(html,/call\('nyx_private_owner_link_status',\{\}\)/);
  assert.match(html,/status\.eligible!==true\)\{section\.hidden=true;return;/);
  assert.match(html,/call\('nyx_private_owner_link_begin',\{\}\)/);
  assert.match(html,/Private legacy credentials remain exclusively on the isolated private service/);
  assert.match(html,/const privateBrokerEnabled=false;/);
  assert.match(html,/id="nyx-private-read-controls" hidden/);
  const privatePanel=renderPanel('private','false','false','true');
  assert.match(privatePanel,/const ownerLinkEnabled=false;/);
  const publicWithoutOptIn=renderPanel('public','true','true','false');
  assert.match(publicWithoutOptIn,/const ownerLinkEnabled=false;/);
});

test('private legacy browse controls need both verified owner linkage and broker opt-in', () => {
  const enabled=renderPanel('public','true','true','true','true');
  assert.match(enabled,/const privateBrokerEnabled=true;/);
  assert.match(enabled,/id="nyx-private-read-controls" hidden/);
  assert.match(enabled,/status\.linked===true && privateBrokerEnabled/);
  assert.match(enabled,/nyx_private_legacy_roots/);
  assert.match(enabled,/nyx_private_legacy_list/);
  assert.match(enabled,/textContent=/);
  const missingLink=renderPanel('public','true','true','false','true');
  assert.match(missingLink,/const privateBrokerEnabled=false;/);
  const privateMode=renderPanel('private','false','false','true','true');
  assert.match(privateMode,/const privateBrokerEnabled=false;/);
});


test('activated storage uses active probe, not consumed pending credential',()=>{
 const html=renderPanel('public','true','true');
 const pendingStart=html.indexOf("if(item.status!=='active'){");
 const activeStart=html.indexOf("if(item.status==='active'){",pendingStart);
 const end=html.indexOf("host.append(box);",activeStart);
 assert.ok(pendingStart>0&&activeStart>pendingStart&&end>activeStart);
 const pending=html.slice(pendingStart,activeStart);
 const active=html.slice(activeStart,end);
 assert.match(pending,/Test new connection/);
 assert.match(pending,/nyx_storage_connection_test_pending/);
 assert.match(pending,/Activate after test/);
 assert.doesNotMatch(active,/nyx_storage_connection_test_pending/);
 assert.doesNotMatch(active,/Activate after test/);
 assert.match(active,/Test active connection/);
 assert.match(active,/nyx_storage_connection_test_active/);
 assert.match(active,/result!=='verified'/);
 assert.match(active,/nyx_storage_connection_list_files/);
 assert.match(html,/root\.readOnly=item\.status==='active'/);
});

test('public storage hides legacy remote placeholders and reports actual grants',()=>{
 const publicHtml=renderPanel('public','true','true');
 assert.match(publicHtml,/id="nyx-mega-list" hidden aria-live="polite"/);
 assert.match(publicHtml,/id="nyx-google-list" hidden aria-live="polite"/);
 assert.match(publicHtml,/Permissions for this connection/);
 assert.match(publicHtml,/providerCapabilities\|\|\[\]\)\.includes\('storage:list'\)/);
 assert.match(publicHtml,/storage:list\) — /);
 assert.match(publicHtml,/Read or download file contents — unavailable in pilot/);
 assert.match(publicHtml,/Upload, edit or move files — unavailable in pilot/);
 assert.match(publicHtml,/Delete files — unavailable in pilot/);
 assert.match(publicHtml,/check\.disabled=true/);
 assert.doesNotMatch(publicHtml,/call\('nyx_storage_connection_permissions',[^\n]*storage:write/);
 const privateHtml=renderPanel('private','false','false');
 assert.doesNotMatch(privateHtml,/id="nyx-mega-list" hidden/);
 assert.doesNotMatch(privateHtml,/id="nyx-google-list" hidden/);
});
