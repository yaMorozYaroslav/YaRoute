/**
 * Self-contained MCP Apps UI. No runtime CDN, direct OAuth credentials, storage
 * APIs, external forms or finance controls. All data/actions go through
 * authenticated MCP tools. Render untrusted names with textContent only.
 */
// Distinct names and cache keys prevent Dev and Pro MCP Apps from sharing a tab identity.
// The deployment environment is authoritative; no owner or secret data affects branding.
const connectionsIsDev = process.env.NYX_DEPLOYMENT_MODE === 'public' ||
  process.env.NYX_SERVICE_NAME === 'DevProNestNyx' ||
  process.env.NYX_PUBLIC_URL === 'https://dev-nest-nyx-0df80c227630.herokuapp.com';
const connectionsKind = connectionsIsDev ? 'dev' : 'pro';
export const CONNECTIONS_PANEL_URI = 'ui://nestnyx/' + connectionsKind + '/connections/v14.html';
export const CONNECTIONS_HOME_URI = 'ui://nestnyx/' + connectionsKind + '/home/v14.html';
export const CONNECTIONS_PANEL_LABEL = connectionsIsDev ? '🔵 NestNyx Dev · Connections' : '🟣 NestNyx Pro · Connections';
export const CONNECTIONS_HOME_LABEL = connectionsIsDev ? '🏠 NestNyx Dev · Home' : '🏠 NestNyx Pro · Home';
// Public users connect only their own storage; never show the operator's
// private Rclone inventory in the shared, authenticated tenant UI.
const publicTenantStorage = process.env.NYX_DEPLOYMENT_MODE === 'public' &&
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
  process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true';
const publicMegaOnly = publicTenantStorage && process.env.NYX_PUBLIC_TENANT_MEGA_ONLY === 'true';
const rcloneFileImportEnabled = publicTenantStorage && process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED === 'true';
const megaMutationEnabled = publicTenantStorage && process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED === 'true';
const ownerLinkEnabled = publicTenantStorage && process.env.NYX_PRIVATE_OWNER_LINK_ENABLED === 'true';
const privateBrokerEnabled = ownerLinkEnabled && process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED === 'true';
const iconOrigin = process.env.NYX_PUBLIC_URL?.startsWith('https://')
  ? new URL(process.env.NYX_PUBLIC_URL).origin : '';
export const CONNECTIONS_PANEL_BRAND_ORIGIN = iconOrigin;
const iconMarkup = iconOrigin
  ? '<img src="'+iconOrigin+'/branding/icon.png" width="28" height="28" alt="" style="width:28px;height:28px;object-fit:contain" />'
  : '';
export const CONNECTIONS_PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${connectionsIsDev ? 'NestNyx Dev · Connections' : 'NestNyx Pro · Connections'}</title>
<style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}
body{margin:0;padding:18px;max-width:950px;color:var(--nyx-fg,inherit)}
h1{font-size:22px;margin:0 0 5px}h2{font-size:17px;margin:0 0 8px}
p{margin:4px 0 12px}small,.muted{opacity:.72}
header{margin-bottom:16px}section{border:1px solid #92929255;border-radius:12px;padding:14px;margin:12px 0}
.card{border-top:1px solid #92929255;padding:14px 0}.card:first-child{border-top:0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin:8px 0}
label{display:inline-flex;align-items:center;gap:5px}
input,select,textarea,button{font:inherit;padding:7px 9px;border:1px solid #8888;border-radius:6px;background:transparent;color:inherit}
input[type=text],textarea{min-width:195px}textarea{width:min(100%,540px);min-height:55px}
button{cursor:pointer;background:color-mix(in srgb,currentColor 8%,transparent)}
button:disabled{opacity:.5;cursor:wait}
.badge{border-radius:16px;padding:2px 8px;background:#8882;font-size:12px}
.warn{border-left:4px solid #b07a06;padding:8px;margin:8px 0;background:#b07a0612}
.error{color:#bf3434} .success{color:#2e8758}
fieldset{border:1px solid #8885;border-radius:7px;margin:7px 0}
.capabilities{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:5px}
.controls{display:flex;flex-wrap:wrap;gap:7px}

#nyx-quick{display:flex;gap:12px;align-items:center;margin-bottom:12px;padding:12px;border:1px solid #92929255;border-radius:14px}
#nyx-quick .spacer{flex:1}#nyx-quick .brand{font-size:17px;font-weight:700}
#nyx-add{background:#087e52;color:white;border:1px solid #087e52;border-radius:12px;width:42px;height:42px;font-size:26px;display:flex;align-items:center;justify-content:center;line-height:1}
#nyx-add:hover{background:#066841}
#nyx-add-menu[hidden],#new-github-container[hidden],#nyx-private-read-controls[hidden]{display:none}
#nyx-provider-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
#nyx-provider-choices button{text-align:left;padding:11px}
#nyx-provider-choices small{display:block;font-weight:400;opacity:.7}
.nyx-provider-group{border:1px solid #92929255;border-radius:12px;margin:9px 0}
.nyx-provider-group>summary{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;font-weight:700;list-style:none}
.nyx-provider-group>summary::-webkit-details-marker{display:none}
.nyx-provider-group>summary:before{content:'▸';opacity:.65}
.nyx-provider-group[open]>summary:before{content:'▾'}
.nyx-provider-group summary:focus-visible,#nyx-add:focus-visible,#nyx-provider-choices button:focus-visible{outline:3px solid #18a56c;outline-offset:2px}
.nyx-provider-count{margin-left:auto;background:#8882;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500}
.nyx-provider-list{padding:0 14px 14px}
.nyx-provider-list .card{margin:5px 0}
.provider-note{font-size:12px;opacity:.75}
.nyx-remote{border-top:1px solid #92929255;padding:8px 0}
.nyx-remote>summary{cursor:pointer;display:flex;align-items:center;gap:9px;padding:6px 0}
.nyx-remote>summary strong{overflow-wrap:anywhere}
.nyx-remote>summary .badge{margin-left:auto}
.nyx-remote .nyx-remote-permissions{padding:7px 4px 11px}
.nyx-remote .nyx-remote-permissions p{margin:5px 0}
.nyx-remote>summary:focus-visible{outline:3px solid #18a56c;outline-offset:2px}

:root{--nyx-accent:#0a927c;--nyx-border:#89959d4f;--nyx-surface:#7998ad0c}
body{max-width:900px;padding:clamp(10px,2.8vw,22px);line-height:1.45}
#nyx-quick{background:var(--nyx-surface);border-color:var(--nyx-border);padding:13px}
#nyx-quick .brand{display:flex;align-items:center;gap:8px;min-width:0}
#nyx-add{background:var(--nyx-accent);border-color:var(--nyx-accent);border-radius:999px!important;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;display:flex;align-items:center;justify-content:center;flex:none}
#nyx-add .nyx-plus-mark{width:20px;height:20px;display:block;position:relative}
#nyx-add .nyx-plus-mark::before,#nyx-add .nyx-plus-mark::after{content:"";position:absolute;display:block;background:#fff;border-radius:3px;top:50%;left:50%;transform:translate(-50%,-50%)}
#nyx-add .nyx-plus-mark::before{width:19px;height:3px}
#nyx-add .nyx-plus-mark::after{width:3px;height:19px}
#nyx-add:hover{background:#087362}
.nyx-logo{width:38px;height:38px;min-width:38px;aspect-ratio:1;border-radius:50%;background:#087e52;color:white;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid #229e90;box-sizing:border-box;font-size:19px;line-height:1}
.nyx-logo img{width:100%!important;height:100%!important;object-fit:cover!important;border-radius:50%;display:block}
#nyx-account-bar .session-switch{font-size:12px;padding:6px 9px;border-radius:8px;border:1px solid var(--nyx-border);margin-top:7px}
#nyx-account-bar .session-reference{font:11px ui-monospace,monospace;opacity:.68;margin-top:4px;overflow-wrap:anywhere}
#nyx-account-bar .account-picker button{font-size:12px}
#nyx-account-bar .session-label{overflow-wrap:anywhere}
#nyx-account-bar .session-person{display:flex;align-items:center;gap:11px;margin:8px 0 2px}
#nyx-account-bar .session-avatar{height:42px;width:42px;min-width:42px;border-radius:50%;border:2px solid var(--nyx-accent);background:#138a82;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:750;overflow:hidden}
#nyx-account-bar .session-avatar img{height:100%;width:100%;object-fit:cover;display:block}
#nyx-account-bar .session-person-main{min-width:0}
#nyx-account-bar .session-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}
#nyx-account-bar .session-actions button{margin-top:0}
#nyx-add-google-login{border-color:var(--nyx-accent)!important}
#nyx-login-add-help{border:1px solid var(--nyx-border);border-radius:10px;padding:9px 11px;margin-top:8px;font-size:12px}
#nyx-login-add-help[hidden],#nyx-switch-help[hidden]{display:none}
#nyx-switch-help{border:1px solid var(--nyx-border);border-radius:10px;padding:9px 11px;margin-top:8px;font-size:12px}
#nyx-session-account-state{font-size:12px;font-weight:650;margin:3px 0;color:var(--nyx-fg,inherit)}

#nyx-account-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,205px);gap:13px;padding:14px;border:1px solid var(--nyx-border);border-radius:14px;background:var(--nyx-surface);margin-bottom:17px}
#nyx-account-bar .kicker{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.06em}
#nyx-account-bar .session-label{font-weight:700;font-size:15px}
#nyx-account-bar .account-detail{font-size:12px;opacity:.78;overflow-wrap:anywhere;margin-top:5px}
#nyx-account-bar .account-picker{display:flex;flex-direction:column;gap:5px}
#nyx-account-bar label{font-size:12px}
#nyx-account-bar select,#nyx-google-shortcut{width:100%;box-sizing:border-box;border-radius:9px;min-height:38px}
#nyx-google-shortcut{border-color:var(--nyx-accent)}
.nyx-provider-group{background:var(--nyx-surface);border-color:var(--nyx-border);overflow:hidden}
.nyx-provider-group[open]>summary{border-bottom:1px solid var(--nyx-border)}
.nyx-provider-list .card{border:1px solid var(--nyx-border);border-radius:11px;padding:12px;margin:9px 0;background:var(--nyx-surface)}
.nyx-provider-list .card:first-child{border-top:1px solid var(--nyx-border)}
.nyx-provider-list .card.nyx-selected{border-color:var(--nyx-accent);box-shadow:inset 3px 0 var(--nyx-accent)}
.nyx-provider-list .nyx-connection-detail{opacity:.76;font-size:12px;overflow-wrap:anywhere}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--nyx-accent);outline-offset:2px}
@media(max-width:520px){#nyx-account-bar{grid-template-columns:1fr}#nyx-quick>.muted{display:none}}
</style></head>
<body>
<div id="nyx-quick">
<strong class="brand"><span class="nyx-logo" aria-hidden="true">${iconMarkup || "🌀"}</span> ${connectionsIsDev ? '🔵 NestNyx Dev' : '🟣 NestNyx Pro'}</strong><span class="muted">Connections</span><span class="spacer"></span>
<button id="nyx-add" type="button" title="Add a connection" aria-label="Add a connection" aria-expanded="false" aria-controls="nyx-add-menu"><span class="nyx-plus-mark" aria-hidden="true"></span></button>
</div>
<div id="nyx-account-bar" aria-label="Current session and selected storage account">
 <div><div class="kicker">Current Google login for this panel</div>
 <div id="nyx-session-account-state" role="status" aria-live="polite">Identifying the OAuth connection…</div>
 <div class="session-person"><span class="session-avatar" id="nyx-session-avatar" aria-label="Google profile avatar unavailable">G</span>
 <div class="session-person-main"><div class="session-label" id="nyx-session-user">Checking signed-in account…</div>
 <div class="session-reference" id="nyx-session-reference">OAuth verification pending</div></div></div>
 <div class="session-actions"><button class="session-switch" id="nyx-add-google-login" type="button" aria-expanded="false" aria-controls="nyx-login-add-help">+ Add Google account</button>
 <button class="session-switch" id="nyx-view-both-google" type="button">View both Google accounts</button>
 <button class="session-switch" id="nyx-switch-login" type="button" aria-expanded="false" aria-controls="nyx-switch-help">About account views</button></div>
 <div id="nyx-login-add-help" hidden role="region" aria-label="Add a Google login">
 <strong>Keep your existing account connected.</strong>
 <p>To connect another NestNyx Google identity, use ChatGPT Settings → Plugins → NestNyx Dev → Connected accounts → Connect another account, when available. Complete Google OAuth there, then reopen this panel.</p>
 <p>ChatGPT owns the Google login picker. NestNyx cannot start that native picker inside an MCP Apps iframe. This panel's cloud-account selector only shows storage authorized to the current login.</p>
 </div>
 <div id="nyx-switch-help" hidden role="region" aria-label="How multi-account views work">
 <strong>Primary and Personal stay connected simultaneously.</strong>
 <p>View both Google accounts loads two separately authenticated, read-only connection summaries into ONE panel with Primary and Personal tabs. Selecting a tab changes the visible list only: no OAuth login switching and no reconnection.</p>
 <p>ChatGPT requests a signed three-minute snapshot from each linked account. Every actual operation still uses the exact connection owner's OAuth credentials and server-enforced grants. No account inherits another account's private Rclone or MEGA credentials.</p>
 <p>Manage the two native logins under ChatGPT Settings → Plugins → DevNestNyx → Connected accounts.</p>
 </div>
 <p class="account-detail" id="nyx-active-identity">No active cloud account selected.</p>
 </div>
 <div class="account-picker">
 <label for="nyx-account-select">Selected cloud account</label>
 <select id="nyx-account-select" aria-label="Switch between your authorized storage accounts"><option value="">No active account</option></select>
 <button id="nyx-google-shortcut" type="button" ${publicMegaOnly ? 'disabled title="Google Drive is disabled in MEGA-only mode"' : ''}>Connect Google Drive</button>
 </div>
</div>
<section id="nyx-add-menu" hidden aria-label="Add a connection">
<h2>Add a connection</h2>
<div id="nyx-provider-choices" role="group" aria-label="Choose a provider">
<button type="button" data-open="nyx-google-group" ${publicMegaOnly ? 'hidden' : ''}>🌈 Google Drive<small>Connect your own Google Drive</small></button>
<button type="button" data-open="nyx-mega-group">🗄️ MEGA<small>Connect your own MEGA account</small></button>
<button type="button" data-open="nyx-rclone-group" ${publicTenantStorage ? 'hidden' : ''}>🧰 Existing Rclone<small>View private configuration metadata</small></button>
<button type="button" id="nyx-import-all" ${rcloneFileImportEnabled ? '' : 'hidden'}>📂 Import Rclone file<small>Automatically connect all supported remotes</small></button>
<button type="button" data-open="nyx-other-group" data-github="true">🐙 GitHub<small>Create a named GitHub connection</small></button>
</div>
<p class="muted">${publicTenantStorage ? (publicMegaOnly ? (megaMutationEnabled ? 'Sign in with Google to NestNyx first. Your MEGA starts with listing access; you can separately request move/rename and delete-to-trash permissions and reauthorize credentials. Live writes require a disposable-file test.' : 'Sign in with Google to NestNyx first, then connect your own read-only MEGA account.') + ' The operator\'s private Rclone is inaccessible to public tenants.' : (megaMutationEnabled ? 'Connect your own Google Drive (read-only pilot) or MEGA (read-only initially, with separately gated move/trash permissions).' : 'Connect your own read-only Google Drive or MEGA storage.') + ' Other users and private legacy remotes remain inaccessible.') : 'Multi-user storage onboarding requires a separate isolated public deployment.'} Never enter credentials in ChatGPT.</p>
</section>
<header><p class="muted">Existing connections grouped by provider. Rclone configuration is not proof of connectivity.</p>
<div class="warn">GitHub permissions and repository writes require explicit grants. No default-branch writes, workflow dispatch, credential editing, billing or infrastructure actions.</div></header>
<h2>Existing connections</h2>
<details class="nyx-provider-group" id="nyx-google-group"><summary>🌈 Google Drive <span class="nyx-provider-count" id="nyx-google-count">Loading</span></summary>
<div class="nyx-provider-list"><div class="row" id="tenant-google-create" hidden><label>Name <input id="tenant-google-name" type="text" maxlength="80" placeholder="My Google Drive"></label><button type="button" id="tenant-google-add">Create Google connection</button></div><div id="tenant-google-list" aria-live="polite"></div><div id="nyx-google-list" ${publicTenantStorage ? 'hidden' : ''} aria-live="polite">Checking configured remotes…</div></div></details>
<details class="nyx-provider-group" id="nyx-mega-group"><summary>🗄️ MEGA <span class="nyx-provider-count" id="nyx-mega-count">Loading</span></summary>
<div class="nyx-provider-list"><div class="row" id="tenant-mega-create" hidden><label>Name <input id="tenant-mega-name" type="text" maxlength="80" placeholder="My MEGA"></label><button type="button" id="tenant-mega-add">Create MEGA connection</button></div><div id="tenant-mega-list" aria-live="polite"></div><div id="nyx-mega-list" ${publicTenantStorage ? 'hidden' : ''} aria-live="polite">Checking configured remotes…</div></div></details>
<details class="nyx-provider-group" id="nyx-rclone-group" ${publicTenantStorage ? 'hidden' : ''}><summary>🧰 Rclone <span class="nyx-provider-count" id="nyx-rclone-count">Private inventory</span></summary>
<div class="nyx-provider-list"><p class="provider-note">Existing private Rclone metadata; remotes are listed under their providers above. This does not import, connect or modify credentials.</p>
<button id="rclone-refresh" type="button">Refresh configured remotes</button>
<div id="rclone-list" role="status" aria-live="polite">Loading…</div>
<div id="rclone-status" role="status" aria-live="polite"></div>
</div></details>
<details class="nyx-provider-group" id="nyx-private-owner-group" hidden><summary>🔐 Private owner identity <span class="nyx-provider-count">Owner only</span></summary>
<div class="nyx-provider-list"><p id="nyx-owner-status">Verification unavailable</p>
<button id="nyx-owner-link" type="button">Verify my Google identity</button>
<p class="muted">Private legacy credentials remain exclusively on the isolated private service. This panel never receives them.</p><div id="nyx-private-read-controls" hidden><div class="row"><button id="nyx-private-roots" type="button">Load my private roots</button><label>Root <select id="nyx-private-root"></select></label><label>Path <input id="nyx-private-path" type="text" maxlength="1024" placeholder="Optional subfolder"></label><button id="nyx-private-list" type="button">List files</button></div><div id="nyx-private-items" aria-live="polite"></div></div></div></details>
<details class="nyx-provider-group" id="nyx-other-group"><summary>🧩 Other services · GitHub <span class="nyx-provider-count" id="nyx-other-count">Loading</span></summary>
<div class="nyx-provider-list">
<div id="new-github-container" hidden><h2>Add GitHub connection</h2>
<form id="new-form" class="row"><label>Name <input id="new-name" type="text" maxlength="80" placeholder="My development projects" required></label><button type="submit">Create GitHub connection</button></form>
<p class="muted">Multiple named, repository-scoped GitHub connections are supported. No secrets are entered here.</p></div>
<div class="row" style="justify-content:space-between"><h2>GitHub connections</h2><button id="refresh" type="button">Refresh GitHub</button></div>
<div id="connection-list" aria-live="polite">Loading…</div>
</div></details>
<div id="message" role="status" aria-live="polite"></div>
<script>
(function(){
'use strict';
const publicTenantStorage=${JSON.stringify(publicTenantStorage)};
const publicMegaOnly=${JSON.stringify(publicMegaOnly)};
const rcloneFileImportEnabled=${JSON.stringify(rcloneFileImportEnabled)};
const megaMutationEnabled=${JSON.stringify(megaMutationEnabled)};
const ownerLinkEnabled=${JSON.stringify(ownerLinkEnabled)};
const privateBrokerEnabled=${JSON.stringify(privateBrokerEnabled)};
const root=document.getElementById('connection-list');
const rcloneRoot=document.getElementById('rclone-list');
const rcloneStatus=document.getElementById('rclone-status');
const status=document.getElementById('message');
const remoteReadChecks=new Map();
const pending=new Map();let rpcId=0,connecting;
function request(method,params){
 return new Promise((resolve,reject)=>{
  const id=++rpcId;pending.set(id,{resolve,reject});
  window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
 });
}
window.addEventListener('message',function(event){
 if(event.source!==window.parent)return;
 const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if(typeof m.id==='number' && pending.has(m.id)){
  const p=pending.get(m.id);pending.delete(m.id);
  if(m.error)p.reject(new Error(m.error.message||'Host refused the request'));
  else p.resolve(m.result);
 }
 if(m.method==='ui/notifications/tool-result')consume(m.params);
});
async function initialize(){
 await request('ui/initialize',{appInfo:{name:'NestNyx connections',version:'1.0.0'},
  appCapabilities:{},protocolVersion:'2026-01-26'});
 window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
}
const ready=initialize();
function show(text,error=false){status.textContent=text;status.className=error?'error':'success';}
function unwrap(response){
 if(response?.isError)throw new Error(response.content?.[0]?.text||'Operation failed');
 return response?.structuredContent?.result || response?.structuredContent || response?.result || null;
}
function consume(response){
 try{
  const data=unwrap(response);
  if(data && Array.isArray(data.connections))render(data.connections);
  if(data && Array.isArray(data.remotes))renderRclone(data);
 }catch(e){show(e.message,true);}
}
async function call(name,args){
 await ready;
 const result=await request('tools/call',{name,arguments:args||{}});
 return unwrap(result);
}
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;}
function button(name,handler){const b=el('button',name);b.type='button';b.addEventListener('click',async()=>{
 b.disabled=true;try{await handler();}catch(e){show(e.message,true);}finally{b.disabled=false;}});return b;}
function input(value){const n=el('input');n.type='text';n.value=value||'';n.maxLength=80;return n;}
function renderRclone(data){
 if(data?.schema!=='nyx.storage.rclone.connections.v1' ||
    data?.status!=='configured_not_live_verified' ||
    !Array.isArray(data.remotes))throw new Error('Invalid Rclone inventory response');
 const entries=data.remotes.filter(x=>x &&
  ['google-drive','mega'].includes(x.provider) &&
  typeof x.name==='string' && Array.isArray(x.aliases));
 for(const [provider,listId,countId] of [
  ['google-drive','nyx-google-list','nyx-google-count'],
  ['mega','nyx-mega-list','nyx-mega-count']]){
  const remotes=entries.filter(x=>x.provider===provider);
  const list=document.getElementById(listId);list.replaceChildren();
  document.getElementById(countId).textContent=remotes.length+' configured';
  if(!remotes.length){list.append(el('p','None configured.'));continue;}
  for(const remote of remotes){
   const line=el('details');line.className='nyx-remote card';
   const head=el('summary');
   const name=el('strong',remote.name);
   const key=provider+':'+remote.name;
   const reported=remote.lastReadCheck;
   const recent=reported && ['verified','failed','timeout'].includes(reported.connectivity) &&
     reported.writeAccess==='not-tested' && typeof reported.checkedAt==='string'
     ? reported : undefined;
   const previous=remoteReadChecks.get(key)||recent;
   const badge=el('span',previous?.connectivity==='verified'?'Read verified':
     previous?.connectivity==='failed'?'Read failed':
     previous?.connectivity==='timeout'?'Timed out':'Not tested');
   badge.className='badge';
   head.append(name,badge);
   line.append(head);
   const info=el('div');info.className='nyx-remote-permissions';
   if(remote.aliases.length)info.append(el('small','Areas: '+remote.aliases.join(', ')));
   const cfg=remote.configuration;
   const scopes=['drive','drive.readonly','drive.file','drive.metadata.readonly'];
   const scope=provider==='google-drive'&&scopes.includes(cfg?.declaredScope)
     ?cfg.declaredScope:'unknown';
   info.append(el('p','Configured scope: '+
     (scope==='drive'?'Read/write requested (drive)':
      scope==='drive.file'?'File-specific write requested (drive.file)':
      scope==='drive.readonly'||scope==='drive.metadata.readonly'?'Read-only requested ('+scope+')':
      'Unknown / provider-dependent')));
   const statusLabel=el('p','Connectivity: '+(previous?.connectivity==='verified'?'Read access verified':
     previous?.connectivity==='failed'?'Read check failed':
     previous?.connectivity==='timeout'?'Read check timed out':'Not tested'));
   statusLabel.setAttribute('aria-live','polite');
   if(previous?.checkedAt){
     const when=new Date(previous.checkedAt);
     if(!Number.isNaN(when.getTime()))info.append(el('small','Last read check: '+when.toLocaleString()));
   }
   info.append(statusLabel);
   info.append(el('p','Write access: Not tested'));
   const test=button('Test connection',async()=>{
     statusLabel.textContent='Connectivity: Testing read access…';
     let result;
     try{result=await call('nyx_rclone_connection_test_read',{provider,name:remote.name});}
     catch(e){
       statusLabel.textContent='Connectivity: Read check failed';
       badge.textContent='Read failed';
       throw e;
     }
     if(result?.schema!=='nyx.storage.rclone.read-probe.v1' ||
        result.provider!==provider||result.name!==remote.name ||
        result.writeAccess!=='not-tested' ||
        !['verified','failed','timeout'].includes(result.connectivity) ||
        typeof result.checkedAt!=='string')throw Error('Invalid Rclone read probe result');
     remoteReadChecks.set(key,result);
     const label=result.connectivity==='verified'?'Read access verified':
       result.connectivity==='timeout'?'Read check timed out':'Read check failed';
     statusLabel.textContent='Connectivity: '+label;
     badge.textContent=result.connectivity==='verified'?'Read verified':
       result.connectivity==='timeout'?'Timed out':'Read failed';
   });
   info.append(test);
   if(cfg?.inspection==='available'){
     info.append(el('p','Configuration source: server Rclone settings (read-only display).'));
     if(provider==='google-drive'){
       info.append(el('p','Declared OAuth scope: '+scope));
       info.append(el('p','Shared Drive configured: '+(cfg.sharedDriveConfigured===true?'Yes':'No')));
       info.append(el('p','Root folder restriction configured: '+(cfg.rootFolderConfigured===true?'Yes':'No')));
       info.append(el('p','Service account configured: '+(cfg.serviceAccountConfigured===true?'Yes':'No')));
     }else{
       info.append(el('p','MEGA remote: account permissions cannot be inferred from Rclone config.'));
     }
   }else{
     info.append(el('p','Configuration options unavailable; only the remote name is known.'));
   }
   info.append(el('small','Read checks list the remote root. They do not test writing, deleting, or actual item-level grants. Change settings only in Rclone.'));
   line.append(info);
   list.append(line);
  }
 }
 document.getElementById('nyx-rclone-count').textContent=entries.length+' configured';
 rcloneRoot.replaceChildren(el('p',entries.length+' configured Drive/MEGA remotes. Expand each provider group to see names.'));
}
async function refreshRclone(){
 rcloneStatus.textContent='';
 try{
  const data=await call('nyx_rclone_connections_list',{});
  renderRclone(data);
 }catch(e){
  rcloneRoot.replaceChildren(el('p','Rclone inventory unavailable. Private NYX authorization is required.'));
  for(const id of ['nyx-google-list','nyx-mega-list'])document.getElementById(id).replaceChildren(el('p','Inventory unavailable; no connection verified.'));
  for(const id of ['nyx-google-count','nyx-mega-count','nyx-rclone-count'])document.getElementById(id).textContent='Unavailable';
  rcloneStatus.textContent=e?.message||'Unable to read configured remotes';
  rcloneStatus.className='error';
 }
}

let tenantToolsAvailable=false;
let liveMegaWritesAvailable=megaMutationEnabled;
let selectedTenantAccount='';
async function refreshSessionIdentity(){
 try{
   const identity=await call('nyx_session_info',{});
   if(!identity || identity.authenticated!==true)throw Error('Verified session unavailable');
   const label=identity.email || identity.displayName ||
     (identity.provider+' · Account '+identity.accountHint);
   document.getElementById('nyx-session-user').textContent=label;
   document.getElementById('nyx-session-account-state').textContent=
     (identity.email?'Verified Google login: ':'Google account reference: ')+
     (identity.email||identity.accountHint)+' · This login owns the connections below';
   // Avatar is optional and must come only from verified issuer-signed claims.
   const avatar=document.getElementById('nyx-session-avatar');
   avatar.replaceChildren();
   let photoOk=false;
   if(typeof identity.pictureUrl==='string'){
     try{
       const picture=new URL(identity.pictureUrl);
       if(picture.origin==='https://lh3.googleusercontent.com' && !picture.search && !picture.hash){
         const img=document.createElement('img');img.src=picture.href;
         img.alt='';img.referrerPolicy='no-referrer';
         img.addEventListener('error',()=>{avatar.replaceChildren(document.createTextNode('G'));avatar.setAttribute('aria-label','Google profile avatar unavailable');});
         avatar.append(img);photoOk=true;
       }
     }catch{}
   }
   if(!photoOk)avatar.append(document.createTextNode('G'));
   avatar.setAttribute('aria-label',photoOk?'Google profile photo':'Google profile avatar unavailable');

   document.getElementById('nyx-session-reference').textContent=
     identity.provider+' · Session ID '+identity.accountHint+
     (identity.email?' · verified email':' · email not provided by OAuth provider');
   liveMegaWritesAvailable=identity.storageWriteAvailable===true;
 }catch{
   document.getElementById('nyx-session-user').textContent='Authenticated session';
   document.getElementById('nyx-session-account-state').textContent=
     'Google login information unavailable; this view remains owner-scoped';
   document.getElementById('nyx-session-reference').textContent=
     'Identity details unavailable. Disconnect/reconnect to refresh tools.';
   liveMegaWritesAvailable=false;
   const avatar=document.getElementById('nyx-session-avatar');avatar.replaceChildren(document.createTextNode('G'));
   avatar.setAttribute('aria-label','Google profile avatar unavailable');
 }
}
function updateAccountSelector(connections){
 const active=connections.filter(x=>(x.provider==='google-drive'||x.provider==='mega')&&x.status==='active');
 if(!active.some(x=>x.id===selectedTenantAccount))selectedTenantAccount=active[0]?.id||'';
 const select=document.getElementById('nyx-account-select');select.replaceChildren();
 if(!active.length){
   const o=el('option','No active cloud accounts');o.value='';select.append(o);select.disabled=true;
 }else{
   select.disabled=false;
   for(const item of active){
     const o=el('option',item.displayName+' · '+(item.provider==='mega'?'MEGA':'Google Drive'));
     o.value=item.id;o.selected=item.id===selectedTenantAccount;select.append(o);
   }
 }
 const chosen=active.find(x=>x.id===selectedTenantAccount);
 document.getElementById('nyx-active-identity').textContent=chosen
   ?'Selected storage: '+chosen.displayName+(chosen.provider==='mega' &&
      typeof chosen.externalAccountId==='string' && chosen.externalAccountId.includes('@')
      ?' ('+chosen.externalAccountId+')':'')+
     '. Account selection never changes your authenticated NestNyx user.'
   :'No active cloud account selected. Add and verify an account below.';
}
function renderTenant(connections){
 updateAccountSelector(connections);
 for(const [provider,label] of [['google-drive','google'],['mega','mega']]){
  const host=document.getElementById('tenant-'+label+'-list');
  host.replaceChildren();
  const kind=provider==='mega'?'mega-root':'drive';
  const items=connections.filter(x=>x.provider===provider && x.status!=='revoked');
  document.getElementById('nyx-'+label+'-count').textContent=items.length+' mine';
  host.append(el('p',items.length+' separate NestNyx connection(s).'));
  for(const item of items){
   const box=el('div');box.className='card';
   if(item.id===selectedTenantAccount)box.classList.add('nyx-selected');
   const heading=el('div');heading.className='row';
   heading.append(el('strong',item.displayName));
   const state=el('span',item.status==='active'?'● Connected':'○ Pending');
   state.className='badge';heading.append(state);box.append(heading);
   // Both local Rclone imports and OAuth enrollments use the same metadata controls.
   const naming=el('div');naming.className='row';
   const labelInput=input(item.displayName);labelInput.maxLength=80;
   labelInput.setAttribute('aria-label','Connection display name');
   naming.append(el('span','Display name'),labelInput,button('Save name',async()=>{
     const updated=await call('nyx_storage_connection_rename',{
       id:item.id,name:labelInput.value.trim()});
     if(updated?.id!==item.id)throw Error('Connection rename was not verified');
     show('Connection renamed; existing credentials and permissions unchanged.');
     await refreshTenantStorage();
   }));
   box.append(naming);

   const detail=el('p',item.provider==='mega'&&item.status==='active'?
     'Verified MEGA identity: '+item.externalAccountId:
     item.provider==='google-drive'&&item.status==='active'?
     'Verified Google account (private subject identifier)':'Authorization required');
   detail.className='nyx-connection-detail';box.append(detail);
   if(item.status==='active')box.append(button(
     item.id===selectedTenantAccount?'✓ Selected account':'Use this account',async()=>{
       selectedTenantAccount=item.id;renderTenant(connections);
       show('Selected '+item.displayName+'. Account permissions remain isolated.');
     }));
   const root=input((item.resources||[]).find(x=>x.kind===kind)?.id || (provider==='mega'?'MEGA_ROOT':''));
   root.maxLength=256;
   root.placeholder=provider==='mega'?'MEGA_ROOT or subfolder':'Google folder ID';
   // Activated scope is immutable until separately reauthorized. Editing the
   // text box must not silently invalidate a verified root grant.
   root.readOnly=item.status==='active';
   const line=el('div');line.className='row';
   line.append(el('span','Allowed root'),root);box.append(line);
   const activeRoot=(item.resources||[]).find(x=>x.kind===kind);
   const hasReadList=item.status==='active' &&
     (item.capabilities||[]).includes('storage:list') &&
     (item.providerCapabilities||[]).includes('storage:list') &&
     (activeRoot?.capabilities||[]).includes('storage:list');
   const permissions=el('fieldset');
   permissions.append(el('legend','Permissions for this connection'));
   const scope=el('label');
   const listCheck=el('input');listCheck.type='checkbox';
   listCheck.checked=hasReadList;listCheck.disabled=true;
   scope.append(listCheck,el('span','Browse names (storage:list) — '+(hasReadList?'enabled':'not verified')));
   permissions.append(scope);
   if(provider==='mega' && megaMutationEnabled && item.status==='active'){
     const toggles=[];
     for(const [label,cap] of [['Move/rename files','storage:move'],
       ['Delete files to MEGA rubbish bin','storage:delete']]){
       const row=el('label');const check=el('input');check.type='checkbox';
       check.checked=(item.capabilities||[]).includes(cap) &&
         (activeRoot?.capabilities||[]).includes(cap);
       row.append(check,el('span',label));permissions.append(row);
       toggles.push({cap,check});
     }
     permissions.append(el('p','These checkboxes store your requested MEGA permissions; the provider authorization and a real disposable-file write test are separate.'));
     permissions.append(button('Save file permissions',async()=>{
       const caps=['storage:list',...toggles.filter(x=>x.check.checked).map(x=>x.cap)];
       await call('nyx_storage_connection_permissions',{id:item.id,capabilities:caps});
       await call('nyx_storage_connection_roots',{id:item.id,resources:[
         {kind:'mega-root',id:root.value.trim(),capabilities:caps}]});
       show('File permissions saved. Write access also requires MEGA reauthorization.');
       await refreshTenantStorage();
     }));
     if(!['storage:move','storage:delete'].every(cap=>
         (item.providerCapabilities||[]).includes(cap))){
       permissions.append(button('Reauthorize MEGA for writes',async()=>{
         const result=await call('nyx_storage_connection_begin_mega',
           {id:item.id,rootPath:root.value.trim()});
         const link=new URL(result.url);const base=${JSON.stringify(iconOrigin)};
         if(link.protocol!=='https:' || !base || link.origin!==base ||
           link.pathname!=='/connect/mega/setup')throw Error('Untrusted sign-in URL');
         await request('ui/open-link',{url:result.url});
         show('Reauthorize securely, then finish activation here.');
       }));
     }
     permissions.append(button('Finish pending MEGA reauthorization',async()=>{
       const result=await call('nyx_storage_connection_test_pending',{id:item.id});
       if(result!=='verified')throw Error('Pending MEGA credentials have not passed read probe');
       const activated=await call('nyx_storage_connection_activate',{id:item.id});
       if(activated.status!=='active')throw Error('MEGA activation failed');
       show('MEGA login and read connectivity verified; requested permissions recorded. Rename/move/trash are not proven until tested on a disposable file.');
       await refreshTenantStorage();
     }));
   }else if(provider==='mega'){
     for(const label of [
       'Read/download file contents — not implemented',
       'Rename or move files — disabled by server',
       'Delete to MEGA rubbish bin — disabled by server']){
       const option=el('label');const check=el('input');
       check.type='checkbox';check.disabled=true;
       option.append(check,el('span',label));permissions.append(option);
     }
     permissions.append(el('p','MEGA writes require the Dev server flag, refreshed tools and per-account grants. This connection is currently read-only.'));
   }else{
     for(const label of ['Read or download file contents — unavailable in pilot',
       'Upload, edit or move files — unavailable in pilot',
       'Delete files — unavailable in pilot']){
       const option=el('label');const check=el('input');
       check.type='checkbox';check.disabled=true;check.checked=false;
       option.append(check,el('span',label));permissions.append(option);
     }
   }
   permissions.append(el('p','These are server-enforced grants, not permissions assigned by ChatGPT. Private legacy Rclone remotes are separate.'));
   box.append(permissions);
   const configure=async()=>{
    const value=root.value.trim();
    if(!value || value.length>256)throw Error('Enter an allowed root first');
    await call('nyx_storage_connection_permissions',{id:item.id,capabilities:['storage:list']});
    await call('nyx_storage_connection_roots',{id:item.id,
      resources:[{kind,id:value,capabilities:['storage:list']}]});
    return value;
   };
   if(item.status!=='active'){
   box.append(button('Save allowed root (initially read-only)',async()=>{
    await configure();show('Root selected. Sign in separately to authorize access.');
   }));
   box.append(button(provider==='mega'?'Secure MEGA sign-in':'Google OAuth sign-in',async()=>{
    const value=await configure();
    const args=provider==='mega'?{id:item.id,rootPath:value}:{id:item.id,folderId:value};
    const cmd=provider==='mega'?'nyx_storage_connection_begin_mega':'nyx_storage_connection_begin_google';
    const result=await call(cmd,args);
    if(typeof result?.url!=='string')throw Error('Authorization link missing');
    const url=new URL(result.url);
    const base=${JSON.stringify(iconOrigin)};
    if(url.protocol!=='https:' ||
      (provider==='google-drive' ? 
       (url.hostname!=='accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth') :
       (!base || url.origin!==base || url.pathname!=='/connect/mega/setup'))) {
      throw Error('Unexpected provider sign-in URL');
    }
    await request('ui/open-link',{url:result.url});
    show(provider==='mega' ? 'Complete secure MEGA login, then return to verify read connectivity and activate. Write operations require a later disposable-file test.' : 'Complete Google Drive authorization and return for a read-only test.');
   }));
   if(rcloneFileImportEnabled){
     box.append(button('Import from local Rclone file',async()=>{
       await configure();
       const result=await call('nyx_storage_connection_begin_import',{id:item.id});
       if(typeof result?.url!=='string')throw Error('Import link unavailable');
       const link=new URL(result.url);
       const base=${JSON.stringify(iconOrigin)};
       if(!base||link.protocol!=='https:'||link.origin!==base||
         link.pathname!=='/connect/rclone/import')
         throw Error('Untrusted Rclone import link');
       await request('ui/open-link',{url:result.url});
       show('Select your local rclone.conf on the secure NestNyx HTTPS page. Import one remote only, then return to activate.');
     }));
   }
   box.append(button('Test new connection',async()=>{
    const result=await call('nyx_storage_connection_test_pending',{id:item.id});
    show('Read-only test: '+String(result));
   }));
   box.append(button('Activate after test',async()=>{
    const result=await call('nyx_storage_connection_activate',{id:item.id});
    show('Storage connection: '+String(result.status));
    await refreshTenantStorage();
   }));
   }
   if(item.status==='active'){
    box.append(button('Test active connection',async()=>{
      const rootId=root.value.trim();
      if(!rootId||!(item.resources||[]).some(r=>r.kind===kind&&r.id===rootId))
        throw Error('No active authorized root');
      const result=await call('nyx_storage_connection_test_active',{
        id:item.id,provider,rootId,path:''
      });
      if(result!=='verified')throw Error('Active credential read not verified');
      show('Active '+provider+' read verified on your selected root.');
    }));
    const filePanel=el('div');filePanel.setAttribute('aria-live','polite');
    const folder=input('');folder.maxLength=2048;
    folder.placeholder='Relative folder path';folder.setAttribute('aria-label','Browse folder path');
    const navigation=el('div');navigation.className='row';
    navigation.append(el('label','Folder'),folder);
    navigation.append(button('Up',async()=>{
      const parts=folder.value.trim().split('/').filter(Boolean);
      parts.pop();folder.value=parts.join('/');await browse();
    }));
    box.append(navigation);
    const browse=async()=>{
      const rootId=root.value.trim();
      if(!rootId || !(item.resources||[]).some(r=>r.kind===kind&&r.id===rootId))
        throw Error('Select and save the granted root first');
      const relativeFolder=folder.value.trim();
      const data=await call('nyx_storage_connection_list_files',{
        id:item.id,provider,rootId,path:relativeFolder
      });
      if(!data||!Array.isArray(data.items)||typeof data.truncated!=='boolean')
        throw Error('Storage listing not available');
      filePanel.replaceChildren(el('p','/'+relativeFolder+' — '+data.items.length+' items'+
        (data.truncated?' (additional items hidden)':'')));
      const list=el('ul');
      const can=(cap)=>provider==='mega' && megaMutationEnabled &&
        (item.capabilities||[]).includes(cap) &&
        (item.providerCapabilities||[]).includes(cap) &&
        (activeRoot?.capabilities||[]).includes(cap);
      for(const entry of data.items.slice(0,100)){
        if(!entry||typeof entry.path!=='string')continue;
        const fullPath=[relativeFolder,entry.path].filter(Boolean).join('/');
        const li=el('li');li.append(el('span',(entry.isDir?'📁 ':'📄 ')+entry.path));
        if(entry.isDir){
          li.append(button('Open folder',async()=>{
            folder.value=fullPath;await browse();
          }));
        }else if(can('storage:move')||can('storage:delete')){
          const actions=el('div');actions.className='controls';
          const mutate=async(operation,destinationPath)=>{
            const args={id:item.id,rootId,operation,sourcePath:fullPath};
            if(destinationPath!==undefined)args.destinationPath=destinationPath;
            const result=await call('nyx_storage_mega_file_mutate',args);
            if(result.status!=='verified')throw Error('MEGA operation needs audit reconciliation');
            await browse();
            show('MEGA '+operation+' verified. Audit receipt '+result.id);
          };
          if(can('storage:move')){
            const rename=input(fullPath);rename.maxLength=2048;
            rename.placeholder='New name in same folder';
            actions.append(rename,button('Rename',()=>mutate('rename',rename.value.trim())));
            const move=input(fullPath);move.maxLength=2048;
            move.placeholder='New path within selected root';
            actions.append(move,button('Move',()=>mutate('move',move.value.trim())));
          }
          if(can('storage:delete')){
            // Deliberately single click: authenticated owner + chosen grants; MEGA rubbish bin.
            actions.append(button('Delete to trash',()=>mutate('trash')));
          }
          li.append(actions);
        }
        list.append(li);
      }
      filePanel.append(list);
    };
    box.append(button(provider==='mega' && megaMutationEnabled &&
      ['storage:move','storage:delete'].some(cap=>can(cap)) ?
      'Browse and manage MEGA files' : 'Browse selected folder (read only)',browse));
    box.append(filePanel);
   }
   // Explicit typed confirmation revokes only this NestNyx connection.
   // It does not delete provider files, purge any provider trash, or revoke
   // an OAuth session in the external provider.
   const close=el('details');close.className='nyx-connection-revoke';
   close.append(el('summary','Remove connection and encrypted credentials'));
   close.append(el('p','This disconnects only this account entry in NestNyx. All cloud files remain untouched. For complete provider-side revocation, use the provider security page separately.'));
   const exact='REMOVE CONNECTION '+item.displayName;
   close.append(el('p','Type exactly: '+exact));
   const typed=input('');typed.maxLength=128;
   typed.setAttribute('aria-label','Confirm removal of '+item.displayName);
   close.append(typed,button('Disconnect and erase saved credentials',async()=>{
     if(typed.value!==exact)throw Error('Exact typed confirmation required; nothing removed');
     const outcome=await call('nyx_storage_connection_revoke',{id:item.id});
     if(outcome?.id!==item.id||outcome.status!=='revoked'||
        outcome.localCredentialsDeleted!==true)
       throw Error('Revocation not verified; check server audit status');
     show('Connection revoked; stored NestNyx credentials erased. Provider files were not modified.');
     await refreshTenantStorage();
   }));
   box.append(close);
   host.append(box);
  }
 }
}
async function refreshOwnerLink(){
 if(!ownerLinkEnabled)return;
 const section=document.getElementById('nyx-private-owner-group');
 try{
  const status=await call('nyx_private_owner_link_status',{});
  if(!status || status.eligible!==true){section.hidden=true;return;}
  section.hidden=false;
  document.getElementById('nyx-owner-status').textContent=status.linked===true ?
   (privateBrokerEnabled ? 'Google identity linked. Load your approved private roots.' : 'Google identity linked. Private legacy Rclone broker not activated.') :
   'Approved account: verification required before any private broker access.';
  document.getElementById('nyx-private-read-controls').hidden=!(status.linked===true && privateBrokerEnabled);
 }catch{section.hidden=true;}
}
document.getElementById('nyx-owner-link').addEventListener('click',async()=>{
 try{
  const result=await call('nyx_private_owner_link_begin',{});
  if(typeof result?.url!=='string')throw Error('Owner verification link missing');
  const url=new URL(result.url);
  if(url.protocol!=='https:' || url.hostname!=='accounts.google.com' ||
     url.pathname!=='/o/oauth2/v2/auth')throw Error('Unexpected identity sign-in URL');
  await request('ui/open-link',{url:result.url});
  show('Verify your approved Google account, then return and reopen the panel.');
 }catch(e){show(e.message,true);}
});
document.getElementById('nyx-private-roots').addEventListener('click',async()=>{
 try{
  if(!privateBrokerEnabled)throw Error('Private broker is unavailable');
  const data=await call('nyx_private_legacy_roots',{});
  if(!Array.isArray(data?.roots))throw Error('Private roots unavailable');
  const menu=document.getElementById('nyx-private-root');menu.replaceChildren();
  for(const name of data.roots){
   if(typeof name!=='string'||!/^[A-Z][A-Z0-9_]{0,39}$/.test(name))continue;
   const opt=document.createElement('option');opt.value=name;opt.textContent=name;
   menu.append(opt);
  }
  show('Private root choices refreshed.');
 }catch(e){show(e.message,true);}
});
document.getElementById('nyx-private-list').addEventListener('click',async()=>{
 try{
  if(!privateBrokerEnabled)throw Error('Private broker is unavailable');
  const root=document.getElementById('nyx-private-root').value;
  const path=document.getElementById('nyx-private-path').value.trim();
  const data=await call('nyx_private_legacy_list',{root,path});
  if(!Array.isArray(data?.entries))throw Error('Private listing unavailable');
  const target=document.getElementById('nyx-private-items');target.replaceChildren();
  for(const entry of data.entries){
   if(typeof entry?.name!=='string')continue;
   const row=document.createElement('p');row.textContent=(entry.isDir?'📁 ':'📄 ')+entry.name;
   target.append(row);
  }
  show('Private read completed (maximum 100 entries).');
 }catch(e){show(e.message,true);}
});
async function refreshTenantStorage(){
 try{
  const data=await call('nyx_storage_connections_list',{});
  if(!Array.isArray(data))throw Error('Storage tools unavailable');
  tenantToolsAvailable=true;
  for(const name of ['google','mega'])document.getElementById('tenant-'+name+'-create').hidden=(publicMegaOnly && name==='google');
  renderTenant(data);
 }catch{
  tenantToolsAvailable=false;
  for(const name of ['google','mega']){
   document.getElementById('nyx-'+name+'-count').textContent='Unavailable';
   document.getElementById('tenant-'+name+'-create').hidden=true;
   document.getElementById('tenant-'+name+'-list').replaceChildren(
     el('p','Independent multi-user onboarding is not enabled on this deployment.'));
  }
 }
}
function render(connections){
 root.replaceChildren();
 const github=connections.filter(c=>c && c.provider==='github' && c.status!=='revoked');
 document.getElementById('nyx-other-count').textContent=github.length+' account'+(github.length===1?'':'s');
 if(!github.length){root.append(el('p','No GitHub accounts yet. Use the green + button to add one.'));return;}
 for(const c of github){
  const box=el('div');box.className='card';
  const title=el('div');title.className='row';
  title.append(el('strong',c.displayName),el('span',c.provider),el('span',c.status));
  title.lastChild.className='badge';box.append(title);
  if(c.status==='active')box.append(el('p','Connected account: '+c.externalAccountId));
  const ren=el('div');ren.className='row';const name=input(c.displayName);
  ren.append(name,button('Rename',async()=>{await call('nyx_connection_rename',{id:c.id,name:name.value.trim()});await refresh();}));
  box.append(ren);
  if(c.provider==='github' && c.status==='pending'){
    box.append(el('p','Connect without an installation ID. NestNyx verifies your installed GitHub App and selected repositories after you sign in.'));
    box.append(el('small','If you have multiple NestNyx installations, name this connection exactly like the GitHub account or organization you want to connect.'));
    const row=el('div');row.className='row';
    row.append(button('Authorize GitHub',async()=>{
      const v=await call('nyx_connection_begin_github',{id:c.id});
      if(typeof v?.url!=='string')throw Error('GitHub sign-in link unavailable');
      const oauth=new URL(v.url);
      if(oauth.protocol!=='https:' || oauth.hostname!=='github.com' ||
         oauth.pathname!=='/login/oauth/authorize')throw Error('Invalid GitHub sign-in URL');
      await request('ui/open-link',{url:v.url});
      show('Complete GitHub authorization, return here, then refresh.');
    }),button('Install NestNyx App',async()=>{
      const result=await call('nyx_connection_github_install_url',{id:c.id});
      if(typeof result?.url!=='string' || result.provider!=='github')
        throw Error('GitHub installation link unavailable');
      const install=new URL(result.url);
      if(install.protocol!=='https:' || install.hostname!=='github.com' ||
         !/^\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/.test(install.pathname) ||
         install.search || install.hash)throw Error('Invalid GitHub App installation URL');
      await request('ui/open-link',{url:result.url});
      show('Install NestNyx on selected repositories, then return here and choose Authorize GitHub.');
    }),button('Installed GitHub Apps',async()=>{
      await request('ui/open-link',{url:'https://github.com/settings/installations'});
    }));
    box.append(row);
  }
  if(c.status==='active'){
    const group=el('fieldset');group.append(el('legend','Allowed API operations'));
    const grid=el('div');grid.className='capabilities';const checks=[];
    const allowed=(c.availableCapabilities||[]).filter(x=>
      ['repository:metadata','resources:read','contents:write','ci:read','issues:read','issues:write','pulls:read','pulls:write','releases:read'].includes(x));
    for(const cap of allowed){
      const label=el('label');const check=el('input');check.type='checkbox';
      check.checked=(c.capabilities||[]).includes(cap);
      checks.push({cap,check});label.append(check,el('span',cap));grid.append(label);
    }
    group.append(grid,button('Save permissions',async()=>{
      const values=checks.filter(x=>x.check.checked).map(x=>x.cap);
      const result=await call('nyx_connection_permissions',{id:c.id,capabilities:values});
      show(result.authorizationRequired?.length?
        'Saved; provider authorization still required for '+result.authorizationRequired.join(', '):
        'Permissions saved.');
      await refresh();
    }));box.append(group);
    const field=el('fieldset');field.append(el('legend','Resources'));
    field.append(el('p','One repository per line (owner/repo). These repositories must already be granted to your GitHub App.'));
    const area=el('textarea');area.value=(c.resources||[]).map(x=>x.id).join('\n');field.append(area);
    field.append(button('Save resources',async()=>{
      const selected=checks.filter(x=>x.check.checked).map(x=>x.cap);
      const kind='repository';
      const ids=[...new Set(area.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
      await call('nyx_connection_resources',{id:c.id,resources:ids.map(id=>({kind,id,capabilities:selected}))});
      show('Resource selection saved. Provider grants are still enforced.');
      await refresh();
    }));
    box.append(field);
    const ops=el('fieldset');ops.append(el('legend','GitHub development'));
    ops.append(el('p','All file writes stay on nyx/* review branches. Direct main/master changes, workflow or infrastructure files, and merging are not available here.'));
    const opRepo=input((c.resources||[]).find(x=>x.kind==='repository')?.id||'');
    opRepo.placeholder='owner/repository';
    const opBranch=input('nyx/my-change');opBranch.placeholder='nyx/my-change';
    const target=el('div');target.className='row';
    target.append(el('span','Repository'),opRepo,el('span','Review branch'),opBranch);
    ops.append(target);
    const commands=el('div');commands.className='controls';
    commands.append(button('Create review branch',async()=>{
      const result=await call('nyx_connection_github_branch_create',{
        id:c.id,repo:opRepo.value.trim(),branch:opBranch.value.trim()
      });show('Review branch created: '+result.branch);
    }));
    const prTitle=input('');prTitle.placeholder='Draft PR title';
    const prRow=el('div');prRow.className='row';prRow.append(prTitle,
      button('Open draft PR',async()=>{
        const result=await call('nyx_connection_github_draft_pr',{
          id:c.id,repo:opRepo.value.trim(),branch:opBranch.value.trim(),
          title:prTitle.value.trim()
        });
        show('Draft PR #'+result.number+' created. Review it in GitHub before merging.');
      }));
    ops.append(commands,prRow);
    const issueTitle=input('');issueTitle.placeholder='Issue title';
    const issueRow=el('div');issueRow.className='row';issueRow.append(issueTitle,
      button('Create issue',async()=>{
        const result=await call('nyx_connection_github_issue_create',{
          id:c.id,repo:opRepo.value.trim(),title:issueTitle.value.trim()
        });show('GitHub issue #'+result.number+' created.');
      }));
    ops.append(issueRow);
    box.append(ops);
  }
  box.append(button('Disconnect',async()=>{
    if(!confirm('Disconnect from NestNyx? To revoke GitHub authorization completely, also uninstall the GitHub App in GitHub settings.'))return;
    await call('nyx_connection_disconnect',{id:c.id});await refresh();show('Connection revoked in NestNyx.');
  }));
  root.append(box);
 }
}
async function refresh(){
 const data=await call('nyx_connections_list',{});
 if(!data||!Array.isArray(data.connections))throw new Error('Invalid connection response');
 render(data.connections);
}
const quickAdd=document.getElementById('nyx-add');
const addMenu=document.getElementById('nyx-add-menu');
quickAdd.addEventListener('click',()=>{
 addMenu.hidden=!addMenu.hidden;
 quickAdd.setAttribute('aria-expanded',String(!addMenu.hidden));
});
for(const choice of document.querySelectorAll('#nyx-provider-choices button[data-open]')){
 choice.addEventListener('click',()=>{
  const target=document.getElementById(choice.dataset.open);
  if(target)target.open=true;
  if(choice.dataset.github==='true'){
   document.getElementById('new-github-container').hidden=false;
   document.getElementById('new-name').focus();
  }else if(choice.dataset.open==='nyx-rclone-group'){
   show('Rclone credentials must be managed privately on the server. Inventory is read-only.');
  }else{
   const label=choice.dataset.open==='nyx-google-group'?'google':'mega';
   if(tenantToolsAvailable){
    document.getElementById('tenant-'+label+'-create').hidden=(publicMegaOnly && label==='google');
    document.getElementById('tenant-'+label+'-name').focus();
    show('Create a separate '+label+' connection. Never enter credentials into ChatGPT.');
   }else{
    show('New Google Drive/MEGA authorization is not enabled on this deployment.');
   }
  }
  addMenu.hidden=true;
  quickAdd.setAttribute('aria-expanded','false');
 });
}
document.getElementById('nyx-add-google-login').addEventListener('click',()=>{
 const help=document.getElementById('nyx-login-add-help');help.hidden=!help.hidden;
 document.getElementById('nyx-add-google-login').setAttribute('aria-expanded',String(!help.hidden));
});
document.getElementById('nyx-switch-login').addEventListener('click',()=>{
 const help=document.getElementById('nyx-switch-help');help.hidden=!help.hidden;
 document.getElementById('nyx-switch-login').setAttribute('aria-expanded',String(!help.hidden));
});
document.getElementById('nyx-view-both-google').addEventListener('click',async()=>{
 const prompt='Open ONE NestNyx Dev combined Connections panel showing BOTH of my already linked Google accounts, Primary and Personal. Use nyx_account_view_snapshot separately with each authenticated plugin connection, then call nyx_accounts_view with both signed snapshots. Render their storage connections as two selectable display-only tabs in the same viewer. Keep both sessions connected, never substitute or share credentials, and make NO file or permission changes.';
 const send=window.openai?.sendFollowUpMessage;
 if(typeof send!=='function')
   return show('Ask ChatGPT: '+prompt,true);
 try{
   await send({prompt});
   show('Requested ONE combined viewer with both connected Google accounts. File operations remain isolated by owner.');
 }catch{
   show('ChatGPT could not open the combined viewer from this panel. Ask in chat: '+prompt,true);
 }
});
document.getElementById('nyx-account-select').addEventListener('change',e=>{
 selectedTenantAccount=e.target.value;refreshTenantStorage();
});
document.getElementById('nyx-google-shortcut').addEventListener('click',()=>{
 if(publicMegaOnly)return show('Google Drive onboarding requires enabling the multi-provider deployment.',true);
 document.getElementById('nyx-google-group').open=true;
 document.getElementById('tenant-google-create').hidden=!tenantToolsAvailable;
 document.getElementById('tenant-google-name').focus();
 show('Create a Google Drive connection, enter its folder ID, and press Google OAuth sign-in. Consent opens securely in your browser.');
});
document.getElementById('refresh').addEventListener('click',()=>refresh().catch(e=>show(e.message,true)));
document.getElementById('nyx-import-all').addEventListener('click',async()=>{
 try{
  const result=await call('nyx_storage_connection_begin_import_all',{});
  if(typeof result?.url!=='string')throw Error('Batch import link unavailable');
  const link=new URL(result.url);
  const base=${JSON.stringify(iconOrigin)};
  if(!base||link.protocol!=='https:'||link.origin!==base||
     link.pathname!=='/connect/rclone/import/batch')
    throw Error('Untrusted Rclone batch import link');
  await request('ui/open-link',{url:result.url});
  show('Select your rclone.conf once. NestNyx will stage and test every supported Google Drive and MEGA remote, then show results.');
 }catch(e){show(e.message||'Cannot begin batch import',true);}
});
document.getElementById('rclone-refresh').addEventListener('click',()=>refreshRclone());
for(const [provider,label] of [['google-drive','google'],['mega','mega']]){
 document.getElementById('tenant-'+label+'-add').addEventListener('click',async()=>{
  const field=document.getElementById('tenant-'+label+'-name');
  const name=field.value.trim();
  if(!name)return show('Choose a connection name.',true);
  try{
   await call('nyx_storage_connection_create',{provider,name});
   field.value='';await refreshTenantStorage();
   show('Connection created. Select a root and authorize this account.');
  }catch(e){show(e.message,true);}
 });
}
document.getElementById('new-form').addEventListener('submit',async e=>{
 e.preventDefault();const name=document.getElementById('new-name').value.trim();
 const provider='github';
 try{await call('nyx_connection_create',{provider,name});await refresh();
  document.getElementById('new-name').value='';show('Connection created. Authorize before using resources.');
 }catch(e){show(e.message,true);}
});
ready.then(()=>{
 refreshSessionIdentity().catch(()=>{});
 refresh().catch(e=>show(e.message,true));
 if(publicTenantStorage){
  refreshTenantStorage();
  if(ownerLinkEnabled)refreshOwnerLink();
 }else refreshRclone();
}).catch(e=>show('MCP Apps unavailable: '+e.message,true));
})();
</script></body></html>`;

// The sidebar/home launcher receives its own resource title, not a duplicate tab.
// Both views keep exactly the same authenticated owner-scoped RPC behaviour.
export const CONNECTIONS_HOME_HTML = CONNECTIONS_PANEL_HTML
  .replace(/<title>[^<]*<\/title>/, '<title>'+(connectionsIsDev ? 'NestNyx Dev · Home' : 'NestNyx Pro · Home')+'</title>')
  .replace('<span class="muted">Connections</span>', '<span class="muted">Home</span>');
