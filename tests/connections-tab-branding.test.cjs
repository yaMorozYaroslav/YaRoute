const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');

const modulePath=require.resolve('../dist/connectors/connections-panel');
const keys=['NYX_DEPLOYMENT_MODE','NYX_SERVICE_NAME','NYX_PUBLIC_URL',
  'NYX_PUBLIC_CONNECTORS_ENABLED','NYX_MULTIUSER_RCLONE_ENABLED'];
function view(mode,service,url){
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  process.env.NYX_DEPLOYMENT_MODE=mode;
  process.env.NYX_SERVICE_NAME=service;
  process.env.NYX_PUBLIC_URL=url;
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED=mode==='public'?'true':'false';
  process.env.NYX_MULTIUSER_RCLONE_ENABLED=mode==='public'?'true':'false';
  delete require.cache[modulePath];
  const panel=require(modulePath);
  return {
    connectionsUri:panel.CONNECTIONS_PANEL_URI,
    homeUri:panel.CONNECTIONS_HOME_URI,
    connectionsLabel:panel.CONNECTIONS_PANEL_LABEL,
    homeLabel:panel.CONNECTIONS_HOME_LABEL,
    connectionsHtml:panel.CONNECTIONS_PANEL_HTML,
    homeHtml:panel.CONNECTIONS_HOME_HTML,
  };
 }finally{
  for(const [k,v] of Object.entries(saved))
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  delete require.cache[modulePath];
 }
}

test('blue Dev pilot and purple private Pro get distinct branded MCP Apps resource IDs',()=>{
 const dev=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com');
 const pro=view('private','NestNyx','https://example.com');
 assert.match(dev.connectionsUri,/\/dev\/connections\/v14\.html$/);
 assert.match(pro.connectionsUri,/\/pro\/connections\/v14\.html$/);
 assert.match(dev.homeUri,/\/dev\/home\/v14\.html$/);
 assert.match(pro.homeUri,/\/pro\/home\/v14\.html$/);
 assert.notEqual(dev.connectionsUri,pro.connectionsUri);
 assert.notEqual(dev.connectionsUri,dev.homeUri);
 assert.notEqual(pro.connectionsUri,pro.homeUri);
 assert.match(dev.connectionsLabel,/🔵 NestNyx Dev/);
 assert.match(pro.connectionsLabel,/🟣 NestNyx Pro/);
 assert.match(dev.homeLabel,/🏠 NestNyx Dev/);
 assert.match(pro.homeLabel,/🏠 NestNyx Pro/);
 assert.notEqual(dev.homeLabel,dev.connectionsLabel);
 assert.notEqual(pro.homeLabel,pro.connectionsLabel);
 assert.match(dev.connectionsHtml,/<title>NestNyx Dev · Connections<\/title>/);
 assert.match(pro.connectionsHtml,/<title>NestNyx Pro · Connections<\/title>/);
 assert.match(dev.homeHtml,/<title>NestNyx Dev · Home<\/title>/);
 assert.match(pro.homeHtml,/<title>NestNyx Pro · Home<\/title>/);
 assert.match(dev.homeHtml,/<span class="muted">Home<\/span>/);
 assert.match(dev.connectionsHtml,/<span class="muted">Connections<\/span>/);
 assert.match(dev.connectionsHtml,/\/branding\/icon\.png/);
 assert.match(pro.connectionsHtml,/\/branding\/icon\.png/);
});

test('Connections UI selects an authenticated owner-scoped account without switching the ChatGPT principal',()=>{
 const dev=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com');
 const html=dev.connectionsHtml;
 assert.match(html,/id="nyx-account-select"/);
 assert.match(html,/id="nyx-active-identity"/);
 assert.match(html,/id="nyx-google-shortcut"/);
 assert.match(html,/function updateAccountSelector\(connections\)/);
 assert.match(html,/const active=connections\.filter\(/);
 assert.match(html,/item\.status==='active'/);
 assert.match(html,/Account selection never changes your authenticated NestNyx user/);
 assert.match(html,/@media\(max-width:520px\)/);
 assert.match(html,/Google OAuth sign-in/);
 assert.doesNotMatch(html,/localStorage|sessionStorage|document\.cookie/);
});

test('signed-in account, storage switcher, CSS plus and truthful MEGA write-gating are shown',()=>{
 const dev=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com');
 const html=dev.connectionsHtml;
 assert.match(html,/id="nyx-session-user"/);
 assert.match(html,/id="nyx-session-reference"/);
 assert.match(html,/id="nyx-switch-login"/);
 assert.match(html,/call\('nyx_session_info',\{\}\)/);
 assert.match(html,/identity\.email \|\| identity\.displayName/);
 assert.match(html,/Disconnect\/reconnect to refresh tools/);
 assert.match(html,/The storage dropdown below only changes your current login's MEGA\/Drive connection|Every actual operation still uses the exact connection owner's OAuth credentials/);
 assert.match(html,/class="nyx-plus-mark"/);
 assert.match(html,/nyx-plus-mark::before/);
 assert.match(html,/border-radius:999px!important/);
 assert.match(html,/Delete to MEGA rubbish bin — disabled by server/);
 assert.match(html,/Refresh/);
 assert.doesNotMatch(html,/localStorage|sessionStorage|document\.cookie/);
});

test('verified profile avatar and Google-account addition guide are usable and never switch the tenant',()=>{
 const html=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com').connectionsHtml;
 assert.match(html,/id="nyx-session-avatar"/);
 assert.match(html,/identity\.pictureUrl/);
 assert.match(html,/lh3\.googleusercontent\.com/);
 assert.match(html,/id="nyx-add-google-login"/);
 assert.match(html,/aria-controls="nyx-login-add-help"/);
 assert.match(html,/Connect another account/);
 assert.match(html,/cannot start that native picker inside an MCP Apps iframe/);
 assert.match(html,/id="nyx-login-add-help" hidden/);
 assert.match(html,/setAttribute\('aria-expanded',String\(!help\.hidden\)\)/);
 assert.doesNotMatch(html,/localStorage|sessionStorage|document\.cookie/);
});

test('combined account viewer is display-only and does not switch OAuth connections',()=>{
 const html=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com').connectionsHtml;
 assert.match(html,/Current Google login for this panel/);
 assert.match(html,/id="nyx-session-account-state" role="status"/);
 assert.match(html,/Google account reference:/);
 assert.match(html,/This login owns the connections below/);
 assert.match(html,/id="nyx-view-both-google"/);
 assert.match(html,/View both Google accounts/);
 assert.match(html,/id="nyx-switch-login" type="button" aria-expanded="false" aria-controls="nyx-switch-help"/);
 assert.match(html,/id="nyx-switch-help" hidden/);
 assert.match(html,/Primary and Personal stay connected simultaneously/);
 assert.match(html,/signed three-minute snapshot from each linked account/);
 assert.match(html,/ONE combined viewer/);
 assert.match(html,/nyx_account_view_snapshot/);
 assert.match(html,/nyx_accounts_view/);
 assert.match(html,/sendFollowUpMessage/);
 assert.match(html,/no OAuth login switching and no reconnection/);
 assert.doesNotMatch(html,/id="nyx-switch-account-label"|id="nyx-open-google-account"/);
 assert.doesNotMatch(html,/document\\.cookie|localStorage|sessionStorage/);
});
