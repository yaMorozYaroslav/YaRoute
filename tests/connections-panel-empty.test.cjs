const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {CONNECTIONS_PANEL_URI,CONNECTIONS_PANEL_HTML}=require('../dist/connectors/connections-panel');

test('public-facing empty panel starts with a + and no private storage inventory',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.equal(CONNECTIONS_PANEL_URI,'ui://nestnyx/connections/v3.html');
 assert.match(html,/<body class="nyx-empty">/);
 assert.match(html,/<button type="button" id="nyx-add"[^>]+>\+<\/button>/);
 assert.match(html,/aria-label="Add Google Drive or MEGA connection"/);
 assert.match(html,/body\.nyx-empty:not\(\.nyx-adding\) section/);
 assert.match(html,/section\.storage-section/);
 assert.match(html,/☁️ NestNyx/);
 assert.doesNotMatch(html,/Configured in Rclone|Refresh drives|nyx_rclone_connections_list/);
 assert.doesNotMatch(html,/Remote: |Areas: /);
});

test('the + shows friendly provider choices without requiring a technical remote name',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.match(html,/classList\.toggle\('nyx-adding'\)/);
 assert.match(html,/classList\.toggle\('nyx-empty',!hasConnections\)/);
 assert.match(html,/data\.connections\.some\(c=>c&&c\.status!=='revoked'\)/);
 assert.match(html,/id="rclone-new-provider"/);
 assert.match(html,/<option value="google-drive">🌈 Google Drive<\/option>/);
 assert.match(html,/<option value="mega">🗄️ MEGA<\/option>/);
 assert.match(html,/id="rclone-new-label"/);
 assert.doesNotMatch(html,/id="rclone-new-remote"/);
 assert.match(html,/remoteName='nyx_'/);
 assert.ok(!html.includes('localStorage'));
});

test('Connections Panel advertises one-click ChatGPT sidebar and chat-tab launchers',()=>{
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 assert.match(mcp,/'openai\/ui':\{entrypoints:\[\{type:'global'\},\{type:'thread'\}\]\}/);
 assert.match(mcp,/'openai\/outputTemplate':CONNECTIONS_PANEL_URI/);
 assert.match(mcp,/title:'☁️ NestNyx Connections'/);
});

test('embedded panel JavaScript parses without external dependencies',()=>{
 const script=CONNECTIONS_PANEL_HTML.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);
 assert.doesNotThrow(()=>new vm.Script(script[1]));
});
