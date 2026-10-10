/**
 * Self-contained MCP Apps UI. No runtime CDN, direct OAuth credentials, storage
 * APIs, external forms or finance controls. All data/actions go through
 * authenticated MCP tools. Render untrusted names with textContent only.
 */
export const CONNECTIONS_PANEL_URI = 'ui://nestnyx/connections/v1.html';
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
</style></head>
<body><header><h1>⚙️ NestNyx connections</h1>
<p class="muted">Your services, your names, your selected resources. No CLI, no billing or payment access.</p>
<div class="warn">GitHub API connection requires a GitHub App installation and secure authorization.
Heroku currently requires a separate finance-blind broker. Financial actions are permanently unavailable.</div>
</header>
<section><h2>Add connection</h2><form id="new-form" class="row">
<label>Provider <select id="provider"><option value="github">GitHub</option><option value="heroku">Heroku (broker required)</option></select></label>
<label>Name <input id="new-name" type="text" maxlength="80" placeholder="My development projects" required></label>
<button type="submit">Add connection</button></form>
<p><small>You can create multiple connections for the same provider. Old Google/MEGA names remain optional suggestions for future migration.</small></p></section>
<section><div class="row" style="justify-content:space-between"><h2>My connections</h2><button id="refresh">Refresh</button></div>
<div id="connection-list" aria-live="polite">Loading…</div></section>
<section><h2>Technical safeguards</h2><p>Only typed, owner-scoped API operations can be exposed. No Git or Heroku CLI, arbitrary API proxy, plan changes, paid provisioning, financial credentials or payment controls.</p></section>
<div id="message" role="status" aria-live="polite"></div>
<script>
(function(){
'use strict';
const root=document.getElementById('connection-list');
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
function render(connections){
 root.replaceChildren();
 if(!connections.length){root.append(el('p','No connections yet. Add one above.'));return;}
 for(const c of connections){
  const box=el('div');box.className='card';
  const title=el('div');title.className='row';
  title.append(el('strong',c.displayName),el('span',c.provider),el('span',c.status));
  title.lastChild.className='badge';box.append(title);
  if(c.status==='active')box.append(el('p','Connected account: '+c.externalAccountId));
  const ren=el('div');ren.className='row';const name=input(c.displayName);
  ren.append(name,button('Rename',async()=>{await call('nyx_connection_rename',{id:c.id,name:name.value.trim()});await refresh();}));
  box.append(ren);
  if(c.provider==='github' && c.status==='pending'){
    box.append(el('p','Install the NestNyx GitHub App on selected repositories. Copy its installation ID from your GitHub installation settings URL.'));
    const row=el('div');row.className='row';
    const inst=input('');inst.placeholder='GitHub installation ID';inst.inputMode='numeric';
    row.append(inst,button('Authorize GitHub',async()=>{
      const v=await call('nyx_connection_begin_github',{id:c.id,installationId:inst.value.trim()});
      await ready;await request('ui/open-link',{url:v.url});
      show('After authorizing in GitHub, return and click Refresh.');
    }));
    box.append(row);
  }
  if(c.provider==='heroku' && c.status==='pending'){
    const warning=el('div','Heroku activation is not available until a separate, verified finance-blind broker is configured. No Heroku credentials are accepted in this panel.');
    warning.className='warn';box.append(warning);
    const row=el('div');row.className='row';
    const appName=input('');appName.placeholder='Authorized Heroku app';
    row.append(appName,button('Verify via broker',async()=>{
      await call('nyx_connection_verify_heroku',{id:c.id,app:appName.value.trim()});
      show('Heroku app verified by independent read-only broker. Choose permissions and resources next.');
      await refresh();
    }));
    box.append(row);
  }
  if(c.status==='active'){
    const group=el('fieldset');group.append(el('legend','Allowed API operations'));
    const grid=el('div');grid.className='capabilities';const checks=[];
    const allowed=(c.availableCapabilities||[]).filter(x=>c.provider==='github'?
      ['repository:metadata','resources:read','ci:read','issues:read','pulls:read'].includes(x):
      ['heroku:apps:read','heroku:releases:read'].includes(x));
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
    field.append(el('p',c.provider==='github'?
      'One repository per line (owner/repo). These repositories must already be granted to your GitHub App.':
      'One already-existing Heroku app name per line. Only apps independently authorized by the broker are accessible.'));
    const area=el('textarea');area.value=(c.resources||[]).map(x=>x.id).join('\n');field.append(area);
    field.append(button('Save resources',async()=>{
      const selected=checks.filter(x=>x.check.checked).map(x=>x.cap);
      const kind=c.provider==='github'?'repository':'heroku-app';
      const ids=[...new Set(area.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
      await call('nyx_connection_resources',{id:c.id,resources:ids.map(id=>({kind,id,capabilities:selected}))});
      show('Resource selection saved. Provider grants are still enforced.');
      await refresh();
    }));
    box.append(field);
  }
  box.append(button('Disconnect',async()=>{
    if(!confirm('Disconnect this account from NestNyx? GitHub App uninstall must be done separately in GitHub.'))return;
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
document.getElementById('refresh').addEventListener('click',()=>refresh().catch(e=>show(e.message,true)));
document.getElementById('new-form').addEventListener('submit',async e=>{
 e.preventDefault();const name=document.getElementById('new-name').value.trim();
 const provider=document.getElementById('provider').value;
 try{await call('nyx_connection_create',{provider,name});await refresh();
  document.getElementById('new-name').value='';show('Connection created. Authorize before using resources.');
 }catch(e){show(e.message,true);}
});
ready.then(refresh).catch(e=>show('MCP Apps unavailable: '+e.message,true));
})();
</script></body></html>`;
