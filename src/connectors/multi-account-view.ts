import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// A signed, short-lived, read-only summary lets ChatGPT collect snapshots
// independently under each already-authenticated plugin connection and present
// them in ONE account-dropdown UI. It is never a credential, delegation or mutation grant.
export const ACCOUNT_VIEW_SCHEMA = 'nyx.account-view.snapshot.v1';
export const ACCOUNT_VIEW_URI = 'ui://nestnyx/dev/connections/multi-v4.html';
export type StorageViewItem = {
  displayName: string;
  provider: 'mega' | 'google-drive';
  status: 'pending' | 'active' | 'revoked';
  selected: string[];
  providerVerified: string[];
  resourceCount: number;
};
export type StorageViewSnapshot = {
  schema: typeof ACCOUNT_VIEW_SCHEMA;
  ownerHint: string;
  display: string;
  issuedAt: number;
  expiresAt: number;
  connections: StorageViewItem[];
};

function key(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(secret))
    throw new Error('NYX_ACCOUNT_VIEW_KEY_INVALID');
  const bytes=Buffer.from(secret,'base64');
  if(bytes.length!==32 || bytes.toString('base64')!==secret)
    throw new Error('NYX_ACCOUNT_VIEW_KEY_INVALID');
  // Domain separation: never use the storage-encryption key directly as HMAC.
  return createHmac('sha256',bytes).update('nyx-account-view-snapshot-v1').digest();
}
function recordValid(s:StorageViewSnapshot):boolean {
  return !!s && typeof s==='object' &&
    s.schema===ACCOUNT_VIEW_SCHEMA &&
    typeof s.ownerHint==='string' && /^[a-f0-9]{16}$/.test(s.ownerHint) &&
    typeof s.display==='string' && s.display.length>=1 && s.display.length<=120 &&
    Number.isSafeInteger(s.issuedAt) && Number.isSafeInteger(s.expiresAt) &&
    s.expiresAt-s.issuedAt===180 &&
    Array.isArray(s.connections) && s.connections.length<=12 &&
    s.connections.every(c=>c && typeof c==='object' &&
      typeof c.displayName==='string' && c.displayName.length>0 && c.displayName.length<=80 &&
      (c.provider==='mega'||c.provider==='google-drive') &&
      ['pending','active','revoked'].includes(c.status) &&
      Array.isArray(c.selected) && c.selected.length<=4 &&
      c.selected.every(v=>['storage:list','storage:write','storage:move','storage:delete'].includes(v)) &&
      Array.isArray(c.providerVerified) && c.providerVerified.length<=4 &&
      c.providerVerified.every(v=>['storage:list','storage:write','storage:move','storage:delete'].includes(v)) &&
      Number.isSafeInteger(c.resourceCount) && c.resourceCount>=0 && c.resourceCount<=10);
}

export function signStorageView(
  ownerId: string, display: string, connections: StorageViewItem[],
  secret: string, now = Math.floor(Date.now()/1000),
): string {
  if(typeof ownerId!=='string'||!ownerId.startsWith('oauth:')||ownerId.length>700)
    throw new Error('NYX_ACCOUNT_VIEW_OWNER_REQUIRED');
  const snapshot: StorageViewSnapshot={
    schema:ACCOUNT_VIEW_SCHEMA,
    ownerHint:createHash('sha256').update(ownerId).digest('hex').slice(0,16),
    display,issuedAt:now,expiresAt:now+180,connections,
  };
  if(!recordValid(snapshot))throw new Error('NYX_ACCOUNT_VIEW_INVALID');
  const body=Buffer.from(JSON.stringify(snapshot)).toString('base64url');
  if(body.length>10000)throw new Error('NYX_ACCOUNT_VIEW_TOO_LARGE');
  const mac=createHmac('sha256',key(secret)).update(body).digest('base64url');
  return body+'.'+mac;
}
export function verifyStorageView(
  token: string, secret: string, now = Math.floor(Date.now()/1000),
): StorageViewSnapshot {
  if(typeof token!=='string'||token.length>10100||
    !/^[A-Za-z0-9_-]{100,10000}\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('NYX_ACCOUNT_VIEW_TOKEN_INVALID');
  const [body,mac]=token.split('.');
  const signature=createHmac('sha256',key(secret)).update(body).digest();
  const provided=Buffer.from(mac,'base64url');
  if(provided.length!==signature.length||!timingSafeEqual(signature,provided)||
     provided.toString('base64url')!==mac)
    throw new Error('NYX_ACCOUNT_VIEW_SIGNATURE_INVALID');
  const bytes=Buffer.from(body,'base64url');
  if(bytes.toString('base64url')!==body||bytes.length>7500)
    throw new Error('NYX_ACCOUNT_VIEW_TOKEN_INVALID');
  let snapshot:StorageViewSnapshot;
  try{snapshot=JSON.parse(bytes.toString('utf8')) as StorageViewSnapshot;}
  catch{throw new Error('NYX_ACCOUNT_VIEW_TOKEN_INVALID');}
  if(!recordValid(snapshot)||snapshot.issuedAt>now+5||snapshot.expiresAt<now)
    throw new Error('NYX_ACCOUNT_VIEW_EXPIRED_OR_INVALID');
  return snapshot;
}

export const ACCOUNT_VIEW_HTML=`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NestNyx Dev · Connections</title>
<style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;padding:16px;max-width:870px}
h1{font-size:18px;margin:0 0 4px}.muted{opacity:.75;font-size:12px}
header{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:16px}
.account-switch{display:flex;flex-direction:column;gap:6px;margin:14px 0;max-width:420px}
.account-switch label{font-weight:650}
.account-switch select{font:inherit;min-height:44px;padding:9px 12px;border-radius:9px;border:1px solid #8888;background:Canvas;color:CanvasText;width:100%;cursor:pointer}
.account-switch select:focus-visible{outline:2px solid #008b79;outline-offset:2px}
.panel{border:1px solid #8887;border-radius:14px;padding:15px;min-height:130px}
.row{border-bottom:1px solid #8884;padding:10px 0}.row:last-child{border:0}
.row strong{font-size:14px;word-break:break-word}
.meta{margin-top:4px;font-size:12px;opacity:.82;overflow-wrap:anywhere}
.note{margin-top:16px;font-size:12px;opacity:.78}
</style></head><body>
<header><div><h1>NestNyx Dev · Connections</h1>
<div class="muted" id="summary">Collecting authenticated connection summaries</div></div>🔐</header>
<div class="account-switch"><label for="nyx-account-switch">Switch account</label><select id="nyx-account-switch" aria-label="Switch account"><option value="">Loading connected accounts…</option></select></div>
<section id="panel" class="panel" role="region" aria-label="Selected Google account storage" tabindex="0" aria-live="polite">
Waiting for authenticated account summaries…</section>
<p class="note">Switching the displayed account changes only what you see. It does not switch OAuth credentials, link accounts, grant access, or authorize file operations. Snapshots expire after 3 minutes. Use your authenticated account when requesting an action.</p>
<script>
(function(){
 const picker=document.getElementById('nyx-account-switch'),panel=document.getElementById('panel');
 let records=[],current=0;
 let selectedEmail=typeof window.openai?.widgetState?.privateContent?.selectedAccountView==='string'
   ? window.openai.widgetState.privateContent.selectedAccountView : '';
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
 function access(c){
   if(c.status==='pending')return 'PENDING';
   if(c.status==='revoked')return 'REVOKED';
   const grants=['storage:write','storage:move','storage:delete'];
   const verified=grants.filter(cap=>c.selected.includes(cap)&&c.providerVerified.includes(cap));
   return verified.length===3?'RW grants':verified.length?'Partial grants':'RO grants';
 }
 function show(n){
   const v=records[n];if(!v)return;
   current=n;selectedEmail=v.display;picker.value=String(n);
   try{window.openai?.setWidgetState?.({privateContent:{selectedAccountView:selectedEmail}});}
   catch{/* Host presentation state is optional and never affects OAuth. */}
   const active=v.connections.filter(c=>c.status==='active').length;
   panel.replaceChildren(node('strong',v.display));
   panel.append(node('div',active+' active · '+(v.connections.length-active)+' pending/revoked · signed owner '+v.ownerHint,'meta'));
   if(!v.connections.length){panel.append(node('p','No storage connections enrolled for this Google identity.'));return;}
   for(const c of v.connections){
     const row=node('div',undefined,'row');
     row.append(node('strong',c.displayName+' · '+(c.provider==='mega'?'MEGA':'Google Drive')));
     row.append(node('div','Connection: '+c.status+' · '+access(c),'meta'));
     row.append(node('div','Selected: '+(c.selected.join(', ')||'none'),'meta'));
     row.append(node('div','Provider verified: '+(c.providerVerified.join(', ')||'none')+' · Allowed roots: '+c.resourceCount,'meta'));
     panel.append(row);
   }
   panel.append(node('p','RW grants require matching permissions on the exact authorized root and an enabled server write tool. This viewer never executes operations.','note'));
 }
 function render(value){
   const envelope=value?.structuredContent??value;
   const payload=envelope?.result??envelope;
   if(!payload || payload.schema!=='nyx.account-view.viewer.v1' ||
     payload.readOnly!==true || payload.noCrossTenantAuthorization!==true ||
     !Array.isArray(payload.accounts))return;
   if(payload.accounts.length<2||payload.accounts.length>4)return;
   const safe=payload.accounts.every(a=>a&&typeof a.label==='string'&&a.label.length>0&&a.label.length<=40&&
     typeof a.display==='string'&&a.display.length>0&&a.display.length<=120&&
     typeof a.ownerHint==='string'&&/^[a-f0-9]{16}$/.test(a.ownerHint)&&
     Array.isArray(a.connections)&&a.connections.length<=12);
   if(!safe || new Set(payload.accounts.map(a=>a.ownerHint)).size!==payload.accounts.length)return;
   records=payload.accounts;picker.replaceChildren();
   document.getElementById('summary').textContent=records.length+' authenticated accounts · read-only display';
   records.forEach((v,i)=>{
     const o=node('option',v.display);o.value=String(i);picker.append(o);
   });
   picker.disabled=false;
   const previous=records.findIndex(v=>v.display===selectedEmail);
   show(previous>=0?previous:0);
 }
 picker.addEventListener('change',()=>{
   const idx=Number(picker.value);
   if(Number.isSafeInteger(idx) && idx>=0 && idx<records.length)show(idx);
 });
 render(window.openai?.toolOutput);
 window.addEventListener('openai:set_globals',event=>{
   const next=event.detail?.globals?.toolOutput;
   if(next!==undefined)render(next);
 },{passive:true});
 window.addEventListener('message',event=>{
  if(event.source!==window.parent || !event.data ||
    event.data.method!=='ui/notifications/tool-result')return;
  render(event.data.params?.structuredContent??event.data.params);
 });
})();
</script></body></html>`;
