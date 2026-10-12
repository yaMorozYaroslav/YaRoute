/**
 * Self-contained MCP Apps UI. No runtime CDN, direct OAuth credentials, storage
 * APIs, external forms or finance controls. All data/actions go through
 * authenticated MCP tools. Render untrusted names with textContent only.
 */
export const CONNECTIONS_PANEL_URI = 'ui://nestnyx/connections/v6.html';
export const CONNECTIONS_PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NestNyx Connections</title>
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
#nyx-add-menu[hidden],#new-github-container[hidden]{display:none}
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
</style></head>
<body>
<div id="nyx-quick">
<strong class="brand">☁️ NestNyx</strong><span class="muted">Connections</span><span class="spacer"></span>
<button id="nyx-add" type="button" title="Add a connection" aria-label="Add a connection" aria-expanded="false" aria-controls="nyx-add-menu">＋</button>
</div>
<section id="nyx-add-menu" hidden aria-label="Add a connection">
<h2>Add a connection</h2>
<div id="nyx-provider-choices" role="group" aria-label="Choose a provider">
<button type="button" data-open="nyx-google-group">🌈 Google Drive<small>Show configured remotes; new OAuth pending</small></button>
<button type="button" data-open="nyx-mega-group">🗄️ MEGA<small>Show configured remotes; new login pending</small></button>
<button type="button" data-open="nyx-rclone-group">🧰 Existing Rclone<small>View private configuration metadata</small></button>
<button type="button" data-open="nyx-other-group" data-github="true">🐙 GitHub<small>Create a named GitHub connection</small></button>
</div>
<p class="muted">Only GitHub creation is enabled. Google Drive and MEGA authentication is not released; never enter provider credentials in chat.</p>
</section>
<header><p class="muted">Existing connections grouped by provider. Rclone configuration is not proof of connectivity.</p>
<div class="warn">GitHub permissions and repository writes require explicit grants. No default-branch writes, workflow dispatch, credential editing, billing or infrastructure actions.</div></header>
<h2>Existing connections</h2>
<details class="nyx-provider-group" id="nyx-google-group"><summary>🌈 Google Drive <span class="nyx-provider-count" id="nyx-google-count">Loading</span></summary>
<div class="nyx-provider-list" id="nyx-google-list" aria-live="polite">Checking configured remotes…</div></details>
<details class="nyx-provider-group" id="nyx-mega-group"><summary>🗄️ MEGA <span class="nyx-provider-count" id="nyx-mega-count">Loading</span></summary>
<div class="nyx-provider-list" id="nyx-mega-list" aria-live="polite">Checking configured remotes…</div></details>
<details class="nyx-provider-group" id="nyx-rclone-group"><summary>🧰 Rclone <span class="nyx-provider-count" id="nyx-rclone-count">Private inventory</span></summary>
<div class="nyx-provider-list"><p class="provider-note">Existing private Rclone metadata; remotes are listed under their providers above. This does not import, connect or modify credentials.</p>
<button id="rclone-refresh" type="button">Refresh configured remotes</button>
<div id="rclone-list" role="status" aria-live="polite">Loading…</div>
<div id="rclone-status" role="status" aria-live="polite"></div>
</div></details>
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
const root=document.getElementById('connection-list');
const rcloneRoot=document.getElementById('rclone-list');
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
   const line=el('div');line.className='row card';
   line.append(el('strong',remote.name),el('span','Configured · not connectivity-tested'));
   line.lastChild.className='badge';
   if(remote.aliases.length)line.append(el('small','Areas: '+remote.aliases.join(', ')));
   const info=el('details');info.className='nyx-remote-permissions';
   info.append(el('summary','Permissions & Rclone configuration'));
   const cfg=remote.configuration;
   if(cfg?.inspection==='available'){
     info.append(el('p','Source: server Rclone configuration (metadata only; editing disabled).'));
     if(provider==='google-drive'){
       const scopes=['drive.readonly','drive.metadata.readonly','drive.file','drive'];
       const scope=scopes.includes(cfg.declaredScope)?cfg.declaredScope:'unknown';
       info.append(el('p','Declared Google OAuth scope: '+scope));
       info.append(el('p','Requested access: '+
         (scope==='drive.readonly'||scope==='drive.metadata.readonly'?'Read-only':
          scope==='drive'||scope==='drive.file'?'Write-capable scope requested (not verified)':'Unknown; Rclone may use its default scope')));
       info.append(el('p','Shared Drive configured: '+(cfg.sharedDriveConfigured===true?'Yes':'No')));
       info.append(el('p','Root folder restriction configured: '+(cfg.rootFolderConfigured===true?'Yes':'No')));
       info.append(el('p','Service account configured: '+(cfg.serviceAccountConfigured===true?'Yes':'No')));
     }else{
       info.append(el('p','MEGA remote: account permissions cannot be inferred from Rclone config.'));
     }
   }else{
     info.append(el('p','Configuration options unavailable; only the remote name is known.'));
   }
   info.append(el('small','Configured does not mean connected, provider-authorized, or write-capable. Change settings only in Rclone.'));
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
   show('Existing configured remotes are listed here. New Google Drive/MEGA authorization is not enabled in production.');
  }
  addMenu.hidden=true;
  quickAdd.setAttribute('aria-expanded','false');
 });
}
document.getElementById('refresh').addEventListener('click',()=>refresh().catch(e=>show(e.message,true)));
document.getElementById('rclone-refresh').addEventListener('click',()=>refreshRclone());
document.getElementById('new-form').addEventListener('submit',async e=>{
 e.preventDefault();const name=document.getElementById('new-name').value.trim();
 const provider='github';
 try{await call('nyx_connection_create',{provider,name});await refresh();
  document.getElementById('new-name').value='';show('Connection created. Authorize before using resources.');
 }catch(e){show(e.message,true);}
});
ready.then(()=>{
 refresh().catch(e=>show(e.message,true));
 refreshRclone();
}).catch(e=>show('MCP Apps unavailable: '+e.message,true));
})();
</script></body></html>`;
