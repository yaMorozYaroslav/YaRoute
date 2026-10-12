const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {CONNECTIONS_PANEL_URI,CONNECTIONS_PANEL_HTML}=require('../dist/connectors/connections-panel');

test('public-facing empty panel starts with a + and no private storage inventory',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.equal(CONNECTIONS_PANEL_URI,'ui://nestnyx/connections/v8.html');
 assert.match(html,/<body class="nyx-empty">/);
 assert.match(html,/<button[^>]+id="nyx-add"[^>]+>＋<\/button>/);
 assert.match(html,/aria-label="Add connection"/);
 assert.match(html,/body:not\(\.nyx-adding\) #nyx-setup\{display:none\}/);
 assert.match(html,/<section class="storage-section">/);
 assert.match(html,/☁️ NestNyx/);
 assert.doesNotMatch(html,/Configured in Rclone|Refresh drives/);
 assert.match(html,/<details id="nyx-legacy-options" class="nyx-provider-group" hidden>/);
 assert.ok(html.includes('<summary>🧰 Rclone <span class="nyx-provider-count">Private</span></summary>'));
 assert.match(html,/legacyAvailable=data\.legacyInventoryAvailable===true/);
 assert.match(html,/legacyOptions\.hidden=!legacyAvailable/);
 assert.match(html,/legacyLoad\.addEventListener\('click',\(\)=>showLegacyRemotes\(\)\)/);
 assert.match(html,/async function showLegacyRemotes\(\)/);
 assert.match(html,/if\(!legacyAvailable \|\| !legacyOptions\.open\) return/);
 assert.match(html,/call\('nyx_rclone_connections_list',\{\}\)/);
 assert.match(html,/<option value="existing-rclone" hidden disabled>/);
 assert.match(html,/existing=legacyAvailable && selected==='existing-rclone'/);
 assert.match(html,/newCloudLabel\.required=!existing/);
 assert.match(html,/existingOption\.hidden=!legacyAvailable/);
 assert.match(html,/existingOption\.disabled=!legacyAvailable/);
 assert.doesNotMatch(html,/Remote: |Areas: /);
});

test('the + shows friendly provider choices without requiring a technical remote name',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.match(html,/classList\.toggle\('nyx-adding'\)/);
 assert.match(html,/body:not\(\.nyx-adding\) #nyx-setup\{display:none\}/);
 assert.match(html,/<div id="nyx-setup">/);
 assert.match(html,/id="nyx-add"[^>]+aria-expanded="false"/);
 assert.match(html,/title="Add connection">＋<\/button>/);
 assert.match(html,/background:linear-gradient\(120deg,#10a867,#058a58\)/);
 assert.match(html,/classList\.toggle\('nyx-empty',!hasConnections\)/);
 assert.match(html,/data\.connections\.some\(c=>c&&c\.status!=='revoked'\)/);
 assert.match(html,/id="rclone-new-provider"/);
 assert.match(html,/<button type="button" data-provider="google-drive" aria-pressed="false">🌈 Google Drive/);
 assert.match(html,/<button type="button" data-provider="mega" aria-pressed="false">🗄️ MEGA/);
 assert.match(html,/id="rclone-new-label"/);
 assert.doesNotMatch(html,/id="rclone-new-remote"/);
 assert.match(html,/remoteName='nyx_'/);
 assert.ok(!html.includes('localStorage'));
});

test('Connections Panel advertises one-click ChatGPT sidebar and chat-tab launchers',()=>{
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 assert.match(mcp,/'openai\/ui':\{entrypoints:\[\{type:'thread'\}\]\}/);
 assert.match(mcp,/'openai\/ui':\{entrypoints:\[\{type:'global'\}\]\}/);
 assert.match(mcp,/server\.registerTool\('nyx_connections_panel'/);
 assert.match(mcp,/server\.registerTool\('nyx_connections_home'/);
 assert.match(mcp,/'openai\/outputTemplate':CONNECTIONS_PANEL_URI/);
 assert.match(mcp,/title:'☁️ NestNyx Connections'/);
});

test('embedded panel JavaScript parses without external dependencies',()=>{
 const script=CONNECTIONS_PANEL_HTML.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);
 assert.doesNotThrow(()=>new vm.Script(script[1]));
});

test('Drive and MEGA accounts are rendered in separate independent collapsible lists',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.match(html,/<details class="nyx-provider-group" id="nyx-google-group" hidden>/);
 assert.match(html,/<details class="nyx-provider-group" id="nyx-mega-group" hidden>/);
 assert.match(html,/<summary>🌈 Google Drive <span class="nyx-provider-count" id="nyx-google-count">0<\/span><\/summary>/);
 assert.match(html,/<summary>🗄️ MEGA <span class="nyx-provider-count" id="nyx-mega-count">0<\/span><\/summary>/);
 assert.match(html,/const google=linked\.filter\(c=>c\.provider==='google-drive'\)/);
 assert.match(html,/const mega=linked\.filter\(c=>c\.provider==='mega'\)/);
 assert.ok(html.includes("(c.provider==='mega'?megaList:googleList).append(box);"));
 assert.match(html,/count\.textContent=items\.length\+' '\+/);
 assert.match(html,/else if\(wasHidden\)group\.open=items\.length===1/);
 assert.match(html,/revealProvider=provider/);
 assert.match(html,/<div id="nyx-linked-accounts"/);
 assert.ok(html.indexOf('<div id="nyx-linked-accounts"') > html.indexOf('<div id="nyx-setup">'));
 assert.doesNotMatch(html,/id="rclone-linked-list"/);
});


test('Rclone and Other services use separate private/optional expandable groups',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.ok(html.includes('<details id="nyx-legacy-options" class="nyx-provider-group" hidden>'));
 assert.ok(html.includes('<details class="nyx-provider-group" id="nyx-other-group">'));
 assert.ok(html.includes('🧩 Other services'));
 assert.ok(html.includes('legacyOptions.hidden=!legacyAvailable'));
 assert.ok(html.includes('if(!legacyAvailable || !legacyOptions.open) return;'));
 assert.ok(html.includes('id="nyx-google-group"'));
 assert.ok(html.includes('id="nyx-mega-group"'));
 assert.ok(html.includes('id="nyx-add"'));
 assert.ok(html.includes('data-provider="google-drive"'));
 assert.ok(html.includes('data-provider="mega"'));
 assert.ok(html.includes('data-provider="existing-rclone"'));
});


test('green plus Google flow starts consent automatically and retains safe retry',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.match(html,/const linked=await call\('nyx_rclone_connection_link'/);
 assert.match(html,/if\(provider==='google-drive'\)/);
 assert.match(html,/const consent=await call\('nyx_rclone_connection_begin_google',\{id:linked\.id\}\)/);
 assert.match(html,/consent\?\.connectionId!==linked\.id/);
 assert.match(html,/consent\.authorizationUrl\?\.startsWith\('https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?'\)/);
 assert.match(html,/await request\('ui\/open-link',\{url:consent\.authorizationUrl\}\)/);
 assert.match(html,/Use Sign in with Google on that connection to retry/);
 assert.doesNotMatch(html,/<input[^>]+type="password"/);
});


test('Google, MEGA, GitHub and private Rclone setup share one green plus menu',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.equal((html.match(/id="nyx-add"/g)||[]).length,1);
 assert.equal((html.match(/id="new-form"/g)||[]).length,1);
 for(const provider of ['google-drive','mega','github','existing-rclone'])
   assert.ok(html.includes('data-provider="'+provider+'"'));
 assert.ok(html.includes('body:not(.nyx-adding) #nyx-setup{display:none}'));
 assert.ok(html.includes('body:not(.nyx-github-selected) #new-form{display:none}'));
 assert.ok(html.includes("document.body.classList.toggle('nyx-github-selected',selected==='github')"));
 assert.ok(html.includes("else if(providerChoice.value==='github')document.getElementById('new-name').focus()"));
 const setup=html.indexOf('<div id="nyx-setup">');
 const githubForm=html.indexOf('id="new-form"');
 const accountLists=html.indexOf('id="nyx-linked-accounts"');
 assert.ok(setup>=0 && githubForm>setup && accountLists>githubForm);
 assert.ok(html.indexOf('id="nyx-other-group"')>githubForm);
});

test('Rclone configuration stays private and shows option flags but never raw credentials',()=>{
 const html=CONNECTIONS_PANEL_HTML;
 assert.ok(html.includes("item.className='nyx-rclone-remote card'"));
 assert.ok(html.includes("cfg?.inspection==='available'"));
 assert.ok(html.includes('Configured Google scope: '));
 assert.ok(html.includes('Requested access: '));
 assert.ok(html.includes('Shared Drive binding configured: '));
 assert.ok(html.includes('Root folder binding configured: '));
 assert.ok(html.includes('Service account configured: '));
 assert.ok(html.includes('Configured does not mean connected, reachable, or authorized for writes.'));
 assert.ok(html.includes("if(!legacyAvailable || !legacyOptions.open) return"));
});
