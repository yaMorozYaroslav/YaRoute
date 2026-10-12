/**
 * Self-contained MCP Apps UI. No runtime CDN, direct OAuth credentials, storage
 * APIs, external forms or finance controls. All data/actions go through
 * authenticated MCP tools. Render untrusted names with textContent only.
 */
export const CONNECTIONS_PANEL_URI = 'ui://nestnyx/connections/v9.html';
export const CONNECTIONS_PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NestNyx · My connections</title>
<style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}
body{margin:0;padding:18px;max-width:950px;color:var(--nyx-fg,inherit)}
#nyx-add{display:inline-flex;align-items:center;justify-content:center;gap:9px;
 width:42px;height:42px;padding:0;border-radius:13px;color:#fff;font-size:25px;
 background:linear-gradient(120deg,#10a867,#058a58);border:1px solid #0b7f50;
 box-shadow:0 3px 12px #05966926;font-weight:750;font-size:14px;line-height:1.2}
#nyx-add:focus-visible,#rclone-new-provider:focus-visible{outline:3px solid #31d69c;outline-offset:3px}
#nyx-add[aria-expanded="true"]{background:linear-gradient(120deg,#058a58,#08764f)}
@media(prefers-reduced-motion:no-preference){#nyx-add{transition:filter .15s,transform .15s}#nyx-add:hover{transform:translateY(-1px)}}
#nyx-quick{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;
 padding:12px;border-radius:16px;border:1px solid #92929233;background:color-mix(in srgb,currentColor 3%,transparent)}
#nyx-quick .brand{letter-spacing:.1px;font-size:17px}
#nyx-quick .subtitle{display:block;font-size:11px;opacity:.65}
#nyx-quick .spacer{flex:1}
#nyx-quick .add-label{font-weight:600;font-size:12px;opacity:.75}
#nyx-provider-choices{display:flex;flex-direction:column;gap:8px;margin:12px 0}
#nyx-provider-choices button{width:100%;text-align:left;padding:10px 12px;
 border-radius:11px;border:1px solid #92929255;background:transparent;font-weight:650}
#nyx-provider-choices button:hover,#nyx-provider-choices button[aria-pressed="true"]{
 border-color:#10a867;background:color-mix(in srgb,#16a56b 10%,transparent)}
#nyx-provider-choices button[hidden]{display:none}
.nyx-visually-hidden{position:absolute!important;clip-path:inset(50%);width:1px;height:1px;
 overflow:hidden;white-space:nowrap}
body:not(.nyx-provider-selected) #nyx-cloud-name,
body:not(.nyx-provider-selected) #nyx-cloud-create{display:none}
body:not(.nyx-adding) #nyx-setup{display:none}
body:not(.nyx-provider-selected) #rclone-new-form{display:none}
body.nyx-github-selected #rclone-new-form{display:none}
body:not(.nyx-github-selected) #new-form{display:none}
body.nyx-github-selected #new-form{display:flex}
#nyx-setup{padding:12px;border-radius:12px;border:1px solid #18a36a42;
 background:color-mix(in srgb,#17a06e 5%,transparent)}
#nyx-setup h2{margin-top:0}
#nyx-add:hover{filter:brightness(1.08)}
.provider-hint{display:inline-flex;align-items:center;border:1px solid #92929233;
 border-radius:11px;padding:8px 12px;background:color-mix(in srgb,currentColor 4%,transparent);
 margin:4px 7px 9px 0;font-weight:600}
.setup-subtitle{font-size:13px;opacity:.76}
.card{border-radius:10px}
.nyx-provider-list .card{padding:14px;border:1px solid #92929233;margin:10px 0;border-radius:12px}
.nyx-provider-list .card:first-child{border-top:1px solid #92929233}
.nyx-provider-group{margin:10px 0;border:1px solid #92929255;border-radius:13px;
 background:color-mix(in srgb,currentColor 2%,transparent)}
.nyx-provider-group[hidden]{display:none}
.nyx-provider-group summary{display:flex;align-items:center;gap:10px;padding:12px 14px;
 font-size:14px;font-weight:700;cursor:pointer;list-style:none}
.nyx-provider-group summary::-webkit-details-marker{display:none}
.nyx-provider-group summary::before{content:'▸';opacity:.6;font-size:13px}
.nyx-provider-group[open] summary::before{content:'▾'}
.nyx-provider-group summary:focus-visible{outline:2px solid #10a867;outline-offset:2px}
.nyx-provider-group .nyx-provider-count{margin-left:auto;font-weight:500;opacity:.72;
 background:color-mix(in srgb,currentColor 9%,transparent);padding:2px 9px;border-radius:999px}
.nyx-provider-list{padding:0 12px 12px}
.connected-title{font-size:16px;font-weight:600;margin:12px 0 6px}
#rclone-new-form{align-items:flex-end}
#rclone-new-form label{flex-direction:column;align-items:flex-start}
#rclone-new-form button{font-weight:600}
#nyx-legacy-options{margin-top:12px;padding-top:8px;border-top:1px solid #92929233;font-size:12px}
#nyx-legacy-options summary{cursor:pointer;opacity:.78;max-width:max-content;font-weight:650;
 padding:6px 2px}
#nyx-legacy-options summary:focus-visible{outline:2px solid #10a867;outline-offset:2px}
#nyx-legacy-options summary:hover{opacity:1}
#nyx-legacy-list .row{padding:5px 0;border-top:1px solid #92929222}
body.nyx-existing #nyx-cloud-name,body.nyx-existing #nyx-cloud-create{display:none}
body.nyx-existing #nyx-legacy-options{display:block}
#nyx-legacy-options[hidden]{display:none!important}
body.nyx-empty:not(.nyx-adding) header,body.nyx-empty:not(.nyx-adding) #message{display:none}
body.nyx-empty.nyx-adding header{display:none}

body.nyx-empty.nyx-adding #nyx-add{box-shadow:0 3px 12px #05966926}
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
</style></head>
<body class="nyx-empty"><div id="nyx-quick">
<div><strong class="brand">☁️ NestNyx</strong><span class="subtitle">Your cloud connections</span></div>
<span class="spacer"></span>
<span class="add-label">Add connection</span>
<button type="button" id="nyx-add" aria-label="Add connection" aria-controls="nyx-setup" aria-expanded="false" title="Add connection">＋</button>
</div><header><h1>☁️ My cloud connections</h1>
<p class="muted">Connect your own cloud accounts. Each connection belongs to you.</p>
<div class="warn">GitHub branch, file-commit, draft PR and issue writes require additional GitHub App permissions and explicit per-repository grants. No direct default-branch writes, merges, workflow dispatch, Heroku or Vercel access.</div>
</header>
<section class="storage-section"><div id="nyx-setup"><h2>✨ Connect a cloud drive</h2>
<p class="setup-subtitle">Choose a provider and continue to secure sign-in. Never put passwords or recovery keys in chat.</p>
<div id="nyx-provider-choices" role="group" aria-label="Choose a connection type">
<button type="button" data-provider="google-drive" aria-pressed="false">🌈 Google Drive · Sign in with Google</button>
<button type="button" data-provider="mega" aria-pressed="false">🗄️ MEGA · Secure login</button>
<button type="button" data-provider="github" aria-pressed="false">🐙 GitHub · Connect repository</button>
<button type="button" data-provider="existing-rclone" aria-pressed="false" hidden disabled>🧰 Existing Rclone · Private only</button>
</div>
<div id="rclone-status" role="status" aria-live="polite"></div>
<form id="rclone-new-form" class="row">
<label class="nyx-visually-hidden">Provider <select id="rclone-new-provider" tabindex="-1"><option value="">Choose a provider</option><option value="google-drive">Google Drive</option><option value="mega">MEGA</option><option value="github">GitHub</option><option value="existing-rclone" hidden disabled>Existing Rclone</option></select></label>
<label id="nyx-cloud-name">Name your connection <input id="rclone-new-label" type="text" maxlength="80" required placeholder="My files"></label>
<button id="nyx-cloud-create" type="submit">Continue →</button>
</form>
<h3>🐙 Connect GitHub</h3><form id="new-form" class="row">
<span>Provider: <strong>GitHub</strong></span>
<label>Name <input id="new-name" type="text" maxlength="80" placeholder="My development projects" required></label>
<button type="submit">Add connection</button></form>
<p><small>You can create multiple separately named, repo-scoped GitHub connections. No provider secrets are entered in this panel.</small></p>
<p><small>🔒 NestNyx stores account credentials in an encrypted vault. Disconnect anytime.</small></p>

</div>
<div id="nyx-linked-accounts" aria-live="polite">
<details class="nyx-provider-group" id="nyx-google-group" hidden>
<summary>🌈 Google Drive <span class="nyx-provider-count" id="nyx-google-count">0</span></summary>
<div class="nyx-provider-list" id="nyx-google-list"></div>
</details>
<details class="nyx-provider-group" id="nyx-mega-group" hidden>
<summary>🗄️ MEGA <span class="nyx-provider-count" id="nyx-mega-count">0</span></summary>
<div class="nyx-provider-list" id="nyx-mega-list"></div>
</details>
<details id="nyx-legacy-options" class="nyx-provider-group" hidden>
<summary>🧰 Rclone <span class="nyx-provider-count">Private</span></summary>
<p class="muted">For your existing private configuration. Account names stay hidden until you choose to show them. This does not import credentials into the new encrypted vault.</p>
<button type="button" id="nyx-legacy-load">Show existing remotes</button>
<div id="nyx-legacy-list" role="status" aria-live="polite"></div>
</details>
</div>
</section>
<details class="nyx-provider-group" id="nyx-other-group">
<summary>🧩 Other services <span class="nyx-provider-count" id="nyx-other-count">0 accounts</span></summary>
<div class="nyx-provider-list">

<section><div class="row" style="justify-content:space-between"><h2>🐙 GitHub connections</h2><button id="refresh">Refresh GitHub</button></div>
<div id="connection-list" aria-live="polite">Loading…</div></section>
<section><h2>🔐 Technical safeguards</h2><p>Only verified GitHub App installation access and repository-scoped API operations are exposed. No Git, Heroku, or Vercel CLI, infrastructure API, workflow dispatch, plan changes, billing, or payment controls.</p></section>
</div></details>
<div id="message" role="status" aria-live="polite"></div>
<script>
(function(){
'use strict';
const root=document.getElementById('connection-list');
const googleGroup=document.getElementById('nyx-google-group');
const megaGroup=document.getElementById('nyx-mega-group');
const googleList=document.getElementById('nyx-google-list');
const megaList=document.getElementById('nyx-mega-list');
const googleCount=document.getElementById('nyx-google-count');
const megaCount=document.getElementById('nyx-mega-count');
let revealProvider=null;
let megaSetupEnabled=false, legacyAvailable=false, boundRemoteKeys=new Set();
const providerChoice=document.getElementById("rclone-new-provider");
const providerButtons=Array.from(document.querySelectorAll('#nyx-provider-choices button[data-provider]'));
const newCloudLabel=document.getElementById("rclone-new-label");
const legacyOptions=document.getElementById('nyx-legacy-options');
const legacyLoad=document.getElementById('nyx-legacy-load');
const legacyList=document.getElementById('nyx-legacy-list');
const quickAdd=document.getElementById('nyx-add');
function updateProviderChoice(){
 const selected=providerChoice.value;
 const existing=legacyAvailable && selected==='existing-rclone';
 document.body.classList.toggle('nyx-provider-selected',!!selected);
 document.body.classList.toggle('nyx-github-selected',selected==='github');
 for(const option of providerButtons)option.setAttribute('aria-pressed',String(option.dataset.provider===selected));
 document.body.classList.toggle('nyx-existing',existing);
 newCloudLabel.required=!existing;
 legacyOptions.hidden=!legacyAvailable;
 if(existing)legacyOptions.open=true;
 if(!legacyAvailable){legacyOptions.open=false;legacyList.replaceChildren();}
}
providerChoice.addEventListener('change',updateProviderChoice);
for(const option of providerButtons)option.addEventListener('click',()=>{
 if(option.disabled)return;
 providerChoice.value=option.dataset.provider;
 updateProviderChoice();
 if(providerChoice.value==='existing-rclone'){
   document.body.classList.remove('nyx-adding');
   quickAdd.setAttribute('aria-expanded','false');
 }else if(providerChoice.value==='github')document.getElementById('new-name').focus();
 else newCloudLabel.focus();
});
quickAdd.addEventListener('click',()=>{
 document.body.classList.toggle('nyx-adding');
 quickAdd.setAttribute('aria-expanded',String(document.body.classList.contains('nyx-adding')));
 if(document.body.classList.contains('nyx-adding'))document.getElementById('rclone-new-provider').focus();
});
const rcloneStatus=document.getElementById('rclone-status');
const status=document.getElementById('message');
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
 await request('ui/initialize',{appInfo:{name:'NestNyx connections',version:'1.1.0'},
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
async function showLegacyRemotes(){
 if(!legacyAvailable || !legacyOptions.open) return;
 legacyList.replaceChildren(el('span','Loading configured remotes…'));
 try{
  const data=await call('nyx_rclone_connections_list',{});
  if(data?.schema!=='nyx.storage.rclone.connections.v1' ||
     data.status!=='configured_not_live_verified' || !Array.isArray(data.remotes)){
    throw Error('Private Rclone inventory unavailable');
  }
  const remotes=data.remotes.filter(x=>x &&
    (x.provider==='google-drive'||x.provider==='mega') &&
    typeof x.name==='string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(x.name)).slice(0,40);
  legacyList.replaceChildren();
  if(!remotes.length){
    legacyList.append(el('p','No existing remotes found.'));return;
  }
  for(const remote of remotes){
    const item=el('details');
    item.className='nyx-rclone-remote card';
    item.append(el('summary',(remote.provider==='mega'?'🗄️ ':'🌈 ')+remote.name+' · View configuration'));
    const detail=el('div');detail.className='nyx-provider-list';
    const cfg=remote.configuration;
    // Rclone inventory is private-only. Never render arbitrary config keys,
    // raw profiles, token fields, secret paths, URLs, or unrecognized scope strings.
    if(cfg?.inspection==='available'){
      detail.append(el('p','Configuration source: private server Rclone file (metadata only)'));
      if(remote.provider==='google-drive'){
        const allowedScopes=['drive.readonly','drive.metadata.readonly','drive.file','drive'];
        const scope=allowedScopes.includes(cfg.declaredScope)?cfg.declaredScope:'unknown';
        detail.append(el('p','Configured Google scope: '+scope+' (not live-verified)'));
        detail.append(el('p','Requested access: '+
          (scope==='drive.readonly'||scope==='drive.metadata.readonly'?'Read-only':
           scope==='drive'||scope==='drive.file'?'Write-capable OAuth scope, grant unverified':'Unknown')));
        detail.append(el('p','Shared Drive binding configured: '+(cfg.sharedDriveConfigured===true?'Yes':'No')));
        detail.append(el('p','Root folder binding configured: '+(cfg.rootFolderConfigured===true?'Yes':'No')));
        detail.append(el('p','Service account configured: '+(cfg.serviceAccountConfigured===true?'Yes':'No')));
      }else{
        detail.append(el('p','MEGA permissions: unknown from Rclone configuration'));
      }
    }else{
      detail.append(el('p','Configuration inspection unavailable; only remote presence is known.'));
    }
    if(Array.isArray(remote.aliases)&&remote.aliases.length){
      const aliases=remote.aliases.filter(x=>typeof x==='string'&&x.length<=100).slice(0,16);
      detail.append(el('p','Private area aliases: '+aliases.join(', ')));
    }
    detail.append(el('p','Configured does not mean connected, reachable, or authorized for writes.'));
    const line=el('div');line.className='row';
    if(boundRemoteKeys.has(remote.provider+':'+remote.name)){
      line.append(el('small','Already linked'));
    }else{
      const label=input(remote.name.slice(0,80));
      label.placeholder='Display name';
      line.append(label,button('Link existing remote',async()=>{
        const name=label.value.trim();
        if(!name)throw Error('Enter a display name');
        await call('nyx_rclone_connection_link',{
          provider:remote.provider,remoteName:remote.name,name,existingPrivate:true,
        });
        await refresh();
        await showLegacyRemotes();
        show('Existing private remote linked; credentials were not migrated.');
      }));
    }
    detail.append(line);
    item.append(detail);
    legacyList.append(item);
  }
 }catch(e){
  legacyList.replaceChildren(el('small','Unable to load private remotes.'));
  show(e.message,true);
 }
}
legacyLoad.addEventListener('click',()=>showLegacyRemotes());

function render(connections){
 root.replaceChildren();
 const linked=connections.filter(c=>['google-drive','mega'].includes(c.provider)&&c.status!=='revoked');
 const google=linked.filter(c=>c.provider==='google-drive');
 const mega=linked.filter(c=>c.provider==='mega');
 boundRemoteKeys=new Set(linked.map(c=>c.provider+':'+c.externalAccountId));
 for(const {group,list,count,items,provider} of [
   {group:googleGroup,list:googleList,count:googleCount,items:google,provider:'google-drive'},
   {group:megaGroup,list:megaList,count:megaCount,items:mega,provider:'mega'},
 ]){
   const wasHidden=group.hidden;
   group.hidden=false;
   count.textContent=items.length+' '+(items.length===1?'account':'accounts');
   if(!items.length)group.open=false;
   else if(revealProvider===provider)group.open=true;
   else if(wasHidden)group.open=items.length===1;
   list.replaceChildren();
   if(!items.length)list.append(el('p','No connections yet. Use the green + to add one.'));
 }
 for(const c of linked){
   const box=el('div');box.className='card';
   const title=el('div');title.className='row';
   title.append(el('strong',(c.provider==='mega'?'🗄️ ':'🌈 ')+c.displayName),
     el('small',c.status==='active' ? '✅ Connected' : '⏳ Setup pending'));
   box.append(title);
   const access=el('details');access.className='card nyx-account-access';
   access.append(el('summary','Permissions & configuration'));
   const vault=c.connectionType==='isolated-credential-vault';
   access.append(el('p','Connection type: '+(vault?'Owner-scoped encrypted Rclone profile':'Private server Rclone reference')));
   access.append(el('p','Panel operations: read-only browsing and access checks (subject to authorization).'));
   if(c.provider==='google-drive' && vault){
     access.append(el('p','Google OAuth requested scope: Drive read-only. No Drive write tool enabled.'));
   }else if(c.provider==='mega'){
     access.append(el('p','MEGA provider permissions: not inferred from configured credentials.'));
   }else{
     access.append(el('p','Provider scope: see private Rclone declared configuration; grant unverified.'));
   }
   access.append(el('p','Connection record: '+(c.status==='active'?'Active; test access to verify reachability':'Pending setup')));
   if(vault){
     const settings=el('div');settings.className='nyx-rclone-owner-permissions';
     access.append(button('Show configured Drive/MEGA permissions',async()=>{
       const info=await call('nyx_rclone_connection_config',{id:c.id});
       if(info?.schema!=='nyx.storage.rclone.configuration.v1' ||
          info.connectionId!==c.id || info.provider!==c.provider ||
          info.connectionType!=='isolated-credential-vault')throw Error('Invalid permission summary');
       const cfg=info.configuration;
       if(!cfg || cfg.source!=='owner-scoped-encrypted-vault' ||
          cfg.rcloneConfigEditable!==false || cfg.providerGrantVerified!==false)
         throw Error('Unsafe permission summary');
       settings.replaceChildren();
       const scopes=['drive','drive.file','drive.readonly','drive.metadata.readonly'];
       const scope=scopes.includes(cfg.declaredScope)?cfg.declaredScope:'unknown';
       settings.append(el('p','Declared Rclone scope: '+scope));
       settings.append(el('p','Requested access: '+
         (scope==='drive.readonly'||scope==='drive.metadata.readonly'?'Read-only':
          scope==='drive'||scope==='drive.file'?'Write-capable scope requested (not a verified grant)':'Unknown')));
       if(c.provider==='google-drive'){
         settings.append(el('p','Shared Drive configured: '+(cfg.sharedDriveConfigured===true?'Yes':'No')));
         settings.append(el('p','Root folder binding configured: '+(cfg.rootFolderConfigured===true?'Yes':'No')));
         settings.append(el('p','Service account configured: '+(cfg.serviceAccountConfigured===true?'Yes':'No')));
       }else settings.append(el('p','MEGA permissions cannot be inferred from Rclone configuration.'));
       settings.append(el('small','Read-only; edits require reconfiguring and reauthorizing the owner account. Provider grant and actual file permissions remain unverified.'));
     }),settings);
   }
   box.append(access);
   const edit=el('div');edit.className='row';
   const name=input(c.displayName);
   edit.append(name,button('Rename',async()=>{
     await call('nyx_connection_rename',{id:c.id,name:name.value.trim()});
     await refresh();
   }));
   if(c.provider==='google-drive' && c.connectionType==='isolated-credential-vault'){
     edit.append(button('🌈 Sign in with Google',async()=>{
       const v=await call('nyx_rclone_connection_begin_google',{id:c.id});
       if(v?.connectionId!==c.id || !v?.authorizationUrl?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')){
         throw Error('Invalid Google authorization response');
       }
       await request('ui/open-link',{url:v.authorizationUrl});
       show('Complete Google consent, then return and refresh.');
     }));
   }
   if(c.provider==='mega' && c.connectionType==='isolated-credential-vault' && megaSetupEnabled){
     edit.append(button('🗄️ Connect MEGA securely',async()=>{
       const v=await call('nyx_rclone_connection_begin_mega',{id:c.id});
       const u=new URL(v.setupUrl);
       if(v?.connectionId!==c.id || u.protocol!=='https:' ||
          u.pathname!=='/connect/mega/setup' || !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('state')||'')){
         throw Error('Invalid MEGA setup link');
       }
       await request('ui/open-link',{url:v.setupUrl});
       show('A secure, single-use setup form was opened. Return here to test access afterward.');
     }));
   }
   const probe=el('small','Not checked');
   edit.append(button('Test access',async()=>{
     probe.textContent='Checking…';
     try{
       const result=await call('nyx_rclone_connection_test',{id:c.id});
       if(result?.connectionId!==c.id||result?.schema!=='nyx.storage.rclone.probe.v1'||
          !['reachable','unverified'].includes(result.status))throw Error('Invalid Rclone probe result');
       probe.textContent=result.status==='reachable'?'✅ Connection verified':'⚠️ Not verified — check setup';
     }catch(e){probe.textContent='Check failed';show(e.message,true);}
   }),probe);
   edit.append(button('Unlink',async()=>{
     if(!confirm('Disconnect? Local vault credentials will be deleted and Google revocation attempted. MEGA session revocation must be handled at the provider.'))return;
     await call('nyx_connection_disconnect',{id:c.id});
     await refresh();
     show('Connection revoked in Neon. Vault credentials removed if provisioned; existing private legacy Rclone config is unchanged.');
   }));
   box.append(edit);
   if(c.status==='active' && c.connectionType==='isolated-credential-vault'){
     const browser=el('div');browser.className='card';
     browser.append(el('p','Read-only file and folder names (max 50 results).'));
     const folder=input('');
     folder.placeholder='Folder path (blank for root)';
     folder.maxLength=512;
     const results=el('ul');
     const controls=el('div');controls.className='row';
     controls.append(folder,button('Browse folder',async()=>{
       results.replaceChildren(el('li','Loading…'));
       try{
         const data=await call('nyx_rclone_connection_ls',{id:c.id,folder:folder.value.trim()});
         if(data?.connectionId!==c.id || data?.schema!=='nyx.storage.rclone.list.v1' ||
            !Array.isArray(data.entries)) throw Error('Invalid folder list');
         results.replaceChildren();
         for(const item of data.entries.slice(0,50)){
           if(typeof item?.name!=='string' || typeof item?.isDirectory!=='boolean')continue;
           results.append(el('li',(item.isDirectory?'📁 ':'📄 ')+item.name));
         }
         if(!results.children.length)results.append(el('li','Empty folder'));
         if(data.truncated)results.append(el('li','More entries exist; open a narrower folder.'));
       }catch(e){results.replaceChildren(el('li','Unable to list folder'));show(e.message,true);}
     }));
     browser.append(controls,results);
     box.append(browser);
   }
   (c.provider==='mega'?megaList:googleList).append(box);
 }

 revealProvider=null;
 const github=connections.filter(c=>c.provider==='github'&&c.status!=='revoked');
 document.getElementById('nyx-other-count').textContent=github.length+' '+(github.length===1?'account':'accounts');
 if(!github.length)root.append(el('p','No GitHub connections yet. Add one above.'));
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
 megaSetupEnabled=data.megaSelfServiceEnabled===true;
 legacyAvailable=data.legacyInventoryAvailable===true;
 const existingOption=providerChoice.querySelector('option[value="existing-rclone"]');
 if(existingOption){
   existingOption.hidden=!legacyAvailable;
   existingOption.disabled=!legacyAvailable;
 }
 const existingButton=providerButtons.find(x=>x.dataset.provider==='existing-rclone');
 if(existingButton){
   existingButton.hidden=!legacyAvailable;
   existingButton.disabled=!legacyAvailable;
 }
 if(!legacyAvailable && providerChoice.value==='existing-rclone'){
   providerChoice.value='google-drive';
 }
 updateProviderChoice();
 const hasConnections=data.connections.some(c=>c&&c.status!=='revoked');
 document.body.classList.toggle('nyx-empty',!hasConnections);
 if(hasConnections && !document.body.classList.contains('nyx-adding'))quickAdd.setAttribute('aria-expanded','false');
 render(data.connections);
}
document.getElementById('refresh').addEventListener('click',()=>refresh().catch(e=>show(e.message,true)));
document.getElementById('rclone-new-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const provider=providerChoice.value;
 if(provider==='existing-rclone'){
   show('🧰 Use Show existing remotes below to select a private Rclone account.');
   return;
 }
 const remoteName='nyx_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9);
 const name=document.getElementById('rclone-new-label').value.trim();
 if(!['google-drive','mega'].includes(provider) ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remoteName) || !name){
   show('Enter a valid provider, remote name and label.',true);return;
 }
 try{
  const linked=await call('nyx_rclone_connection_link',{provider,remoteName,name});
  document.getElementById('rclone-new-label').value='';
  providerChoice.value='';
  revealProvider=provider;
  await refresh();
  document.body.classList.remove('nyx-adding');
  quickAdd.setAttribute('aria-expanded','false');
  if(provider==='google-drive'){
    // Only a verified owned connection ID from the backend is accepted.
    // The OAuth token exchange happens at NestNyx's callback, never in chat.
    try{
      if(typeof linked?.id!=='string')throw Error('Missing connection identifier');
      const consent=await call('nyx_rclone_connection_begin_google',{id:linked.id});
      if(consent?.connectionId!==linked.id ||
         !consent.authorizationUrl?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')){
        throw Error('Invalid Google consent URL');
      }
      await request('ui/open-link',{url:consent.authorizationUrl});
      show('Google consent opened. Authorize read-only access, then return and refresh.');
    }catch(signInError){
      show('Pending Drive connection saved. Google sign-in did not start: '+
           signInError.message+'. Use Sign in with Google on that connection to retry.',true);
    }
  }else{
    show('Connection saved as pending. Complete provider sign-in to connect.');
  }
 }catch(e){show(e.message,true);}
});
document.getElementById('new-form').addEventListener('submit',async e=>{
 e.preventDefault();const name=document.getElementById('new-name').value.trim();
 const provider='github';
 try{await call('nyx_connection_create',{provider,name});await refresh();
  document.getElementById('new-name').value='';
  providerChoice.value='';updateProviderChoice();
  document.body.classList.remove('nyx-adding');
  quickAdd.setAttribute('aria-expanded','false');
  document.getElementById('nyx-other-group').open=true;
  show('GitHub connection created. Authorize before using resources.');
 }catch(e){show(e.message,true);}
});
ready.then(()=>refresh()).catch(e=>show('Connections unavailable: '+e.message,true));
})();
</script></body></html>`;
