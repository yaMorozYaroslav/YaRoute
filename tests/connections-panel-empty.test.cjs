const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {CONNECTIONS_PANEL_URI,CONNECTIONS_PANEL_HTML}=require('../dist/connectors/connections-panel');

test('empty panel starts as only + and uses a new cache-key URI',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.equal(CONNECTIONS_PANEL_URI,'ui://nestnyx/connections/v4.html');
 assert.match(html,/<body class="nyx-empty">/);
 assert.match(html,/<button type="button" id="nyx-add"[^>]+>\+<\/button>/);
 assert.match(html,/aria-label="Add Google Drive or MEGA connection"/);
 assert.match(html,/body\.nyx-empty:not\(\.nyx-adding\) section/);
 assert.match(html,/section\.storage-section>\*:not\(#rclone-new-form\)/);
 assert.match(html,/class="storage-section"/);
});

test('plus can reveal Google Drive / MEGA form and collapse it without persisting secrets',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.match(html,/classList\.toggle\('nyx-adding'\)/);
 assert.match(html,/classList\.toggle\('nyx-empty',!hasConnections\)/);
 assert.match(html,/data\.connections\.some\(c=>c&&c\.status!=='revoked'\)/);
 assert.match(html,/id="rclone-new-provider"/);
 assert.match(html,/<option value="google-drive">Google Drive<\/option>/);
 assert.match(html,/<option value="mega">MEGA<\/option>/);
 assert.match(html,/id="rclone-new-remote"/);
 assert.match(html,/id="rclone-new-label"/);
 assert.ok(!html.includes('localStorage'));
});

test('embedded panel JS parses successfully without external dependencies',()=>{
 const script=CONNECTIONS_PANEL_HTML.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);
 assert.doesNotThrow(()=>new vm.Script(script[1]));
});
