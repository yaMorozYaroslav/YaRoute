/**
 * Self-contained MCP Apps UI. No runtime CDN, direct OAuth credentials, storage
 * APIs, external forms or finance controls. All data/actions go through
 * authenticated MCP tools. Render untrusted names with textContent only.
 */
export const CONNECTIONS_PANEL_URI = 'ui://nestnyx/connections/v3.html';
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
<p class="muted">Multiple owner-scoped GitHub and Rclone accounts. Account metadata uses the existing Neon PostgreSQL connection registry; provider credentials never enter this panel.</p>
<div class="warn">GitHub branch, file-commit, draft PR and issue writes require additional GitHub App permissions and explicit per-repository grants. No direct default-branch writes, merges, workflow dispatch, Heroku or Vercel access.</div>
</header>
<section><div class="row" style="justify-content:space-between"><h2>Rclone storage connections</h2><button id="rclone-refresh" type="button">Refresh drives</button></div>
<p class="muted">Private mode discovers legacy configured remotes. Isolated-vault mode supports owner-scoped accounts. Google Drive supports read-only OAuth consent; MEGA requires trusted operator provisioning.</p>
<div id="rclone-list" aria-live="polite">Loading configured drives…</div>
<div id="rclone-status" role="status" aria-live="polite"></div>
<form id="rclone-new-form" class="row">
<label>Provider <select id="rclone-new-provider"><option value="google-drive">Google Drive</option><option value="mega">MEGA</option></select></label>
<label>Remote name <input id="rclone-new-remote" type="text" maxlength="120" pattern="[A-Za-z][A-Za-z0-9_.-]*" required placeholder="personal_drive"></label>
<label>Label <input id="rclone-new-label" type="text" maxlength="80" required placeholder="Personal files"></label>
<button type="submit">Create account reference</button>
</form>
<p><small>Google Drive uses read-only OAuth consent in vault mode. MEGA credentials require trusted server administration. The panel never accepts credentials.</small></p>
<h2>Linked Rclone accounts (Neon)</h2>
<p class="muted">Each link has its own immutable connection ID, editable name, and authenticated owner. Vault unlink removes encrypted credentials and attempts Google token revocation; MEGA sessions require provider-side revocation. Legacy remotes remain configured.</p>
<div id="rclone-linked-list" aria-live="polite">Loading account links…</div>
</section>
<section><h2>Add GitHub connection</h2><form id="new-form" class="row">
<span>Provider: <strong>GitHub</strong></span>
<label>Name <input id="new-name" type="text" maxlength="80" placeholder="My development projects" required></label>
<button type="submit">Add connection</button></form>
<p><small>You can create multiple separately named, repo-scoped GitHub connections. No provider secrets are entered in this panel.</small></p></section>
<section><div class="row" style="justify-content:space-between"><h2>GitHub connections</h2><button id="refresh">Refresh GitHub</button></div>
<div id="connection-list" aria-live="polite">Loading…</div></section>
<section><h2>Technical safeguards</h2><p>Only verified GitHub App installation access and repository-scoped API operations are exposed. No Git, Heroku, or Vercel CLI, infrastructure API, workflow dispatch, plan changes, billing, or payment controls.</p></section>
<div id="message" role="status" aria-live="polite"></div>
<script>
(function(){
'use strict';
const root=document.getElementById('connection-list');
const rcloneRoot=document.getElementById('rclone-list');
const rcloneLinkedRoot=document.getElementById('rclone-linked-list');
let boundRcloneKeys=new Set();let lastRcloneInventory=null;
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
 rcloneRoot.replaceChildren();
 if(data?.schema!=='nyx.storage.rclone.connections.v1' ||
    data?.status!=='configured_not_live_verified' ||
    !Array.isArray(data.remotes))throw new Error('Invalid Rclone inventory response');
 const entries=data.remotes.filter(x=>x &&
   ['google-drive','mega'].includes(x.provider) &&
   typeof x.name==='string' && Array.isArray(x.aliases));
 lastRcloneInventory=data;
 if(!entries.length){
  rcloneRoot.append(el('p','No Google Drive or MEGA remotes were reported by private Rclone.'));
  return;
 }
 for(const provider of ['google-drive','mega']){
  const remotes=entries.filter(x=>x.provider===provider);
  const group=el('div');group.className='card';
  group.append(el('strong',provider==='google-drive'?'Google Drive':'MEGA'));
  if(!remotes.length){
   group.append(el('p','None configured.'));rcloneRoot.append(group);continue;
  }
  for(const remote of remotes){
   const line=el('div');line.className='row';
   line.append(el('strong',remote.name),el('span','Configured in Rclone'));
   line.lastChild.className='badge';
   if(remote.aliases.length)line.append(el('small','Areas: '+remote.aliases.join(', ')));
   const bound=boundRcloneKeys.has(remote.provider+':'+remote.name);
   if(bound){
     line.append(el('small','Linked to your account registry'));
   }else{
     const chosenName=input(remote.name.slice(0,80));
     chosenName.placeholder='Connection label';
     line.append(chosenName,button('Link account',async()=>{
       await call('nyx_rclone_connection_link',{
         provider:remote.provider,remoteName:remote.name,name:chosenName.value.trim()
       });
       await refresh();
       show('Account reference saved to Neon. Provider credentials are unchanged.');
     }));
   }
   group.append(line);
  }
  rcloneRoot.append(group);
 }
}
async function refreshRclone(){
 rcloneStatus.textContent='';
 try{
  const data=await call('nyx_rclone_connections_list',{});
  renderRclone(data);
 }catch(e){
  lastRcloneInventory=null;
  rcloneRoot.replaceChildren(el('p','Rclone inventory unavailable. Private NYX authorization and the configured Rclone runtime are required.'));
  rcloneStatus.textContent=e?.message||'Unable to read configured remotes';
  rcloneStatus.className='error';
 }
}
function render(connections){
 root.replaceChildren();
 const linked=connections.filter(c=>['google-drive','mega'].includes(c.provider)&&c.status!=='revoked');
 boundRcloneKeys=new Set(linked.map(c=>c.provider+':'+c.externalAccountId));
 if(lastRcloneInventory)renderRclone(lastRcloneInventory);
 rcloneLinkedRoot.replaceChildren();
 if(!linked.length)rcloneLinkedRoot.append(el('p','No Rclone accounts linked yet. Link an existing configured remote above.'));
 for(const c of linked){
   const box=el('div');box.className='card';
   const title=el('div');title.className='row';
   title.append(el('strong',c.displayName),el('span',c.provider),
     el('span','Remote: '+c.externalAccountId),el('small',c.status==='active' ? 'Provider authorized' : 'Pending authorization'));
   box.append(title);
   const edit=el('div');edit.className='row';
   const name=input(c.displayName);
   edit.append(name,button('Rename',async()=>{
     await call('nyx_connection_rename',{id:c.id,name:name.value.trim()});
     await refresh();
   }));
   if(c.provider==='google-drive' && c.connectionType==='isolated-credential-vault'){
     edit.append(button('Authorize Google Drive (read-only)',async()=>{
       const v=await call('nyx_rclone_connection_begin_google',{id:c.id});
       if(v?.connectionId!==c.id || !v?.authorizationUrl?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')){
         throw Error('Invalid Google authorization response');
       }
       await request('ui/open-link',{url:v.authorizationUrl});
       show('Complete Google consent, then return and refresh.');
     }));
   }
   const probe=el('small','Not checked');
   edit.append(button('Test access',async()=>{
     probe.textContent='Checking…';
     try{
       const result=await call('nyx_rclone_connection_test',{id:c.id});
       if(result?.connectionId!==c.id||result?.schema!=='nyx.storage.rclone.probe.v1'||
          !['reachable','unverified'].includes(result.status))throw Error('Invalid Rclone probe result');
       probe.textContent=result.status==='reachable'?'Provider reachable':'Not verified (provider failure or unsupported operation)';
     }catch(e){probe.textContent='Check failed';show(e.message,true);}
   }),probe);
   edit.append(button('Unlink',async()=>{
     if(!confirm('Disconnect? Local vault credentials will be deleted and Google revocation attempted. MEGA or provider-side sessions may need separate revocation.'))return;
     await call('nyx_connection_disconnect',{id:c.id});
     await refresh();
     show('Account reference revoked in Neon; provider credentials remain configured.');
   }));
   box.append(edit);
   rcloneLinkedRoot.append(box);
 }

 const github=connections.filter(c=>c.provider==='github'&&c.status!=='revoked');
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
document.getElementById('refresh').addEventListener('click',()=>refresh().catch(e=>show(e.message,true)));
document.getElementById('rclone-refresh').addEventListener('click',()=>refreshRclone());
document.getElementById('rclone-new-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const provider=document.getElementById('rclone-new-provider').value;
 const remoteName=document.getElementById('rclone-new-remote').value.trim();
 const name=document.getElementById('rclone-new-label').value.trim();
 if(!['google-drive','mega'].includes(provider) ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remoteName) || !name){
   show('Enter a valid provider, remote name and label.',true);return;
 }
 try{
  await call('nyx_rclone_connection_link',{provider,remoteName,name});
  document.getElementById('rclone-new-remote').value='';
  document.getElementById('rclone-new-label').value='';
  await refresh();
  show('Account reference created in Neon. Provider authorization is not implied.');
 }catch(e){show(e.message,true);}
});
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
