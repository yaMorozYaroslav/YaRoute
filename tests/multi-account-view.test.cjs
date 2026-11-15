const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
 ACCOUNT_VIEW_URI,ACCOUNT_VIEW_HTML,signStorageView,verifyStorageView,
}=require('../dist/connectors/multi-account-view');

const key=Buffer.alloc(32,19).toString('base64');
const wrong=Buffer.alloc(32,20).toString('base64');
const connections=[{displayName:'MEGA research',provider:'mega',status:'active',
 selected:['storage:list','storage:move','storage:delete'],
 providerVerified:['storage:list'],resourceCount:1}];

test('separate OAuth principals yield distinct signed, read-only 3-minute views',()=>{
 const a=signStorageView('oauth:google-oauth2|primary','Google account A',connections,key,10000);
 const b=signStorageView('oauth:google-oauth2|personal','Google account B',[],key,10000);
 const va=verifyStorageView(a,key,10001),vb=verifyStorageView(b,key,10001);
 assert.notEqual(va.ownerHint,vb.ownerHint);
 assert.equal(va.connections[0].provider,'mega');
 assert.deepEqual(va.connections[0].providerVerified,['storage:list']);
 assert.deepEqual(vb.connections,[]);
 assert.equal(va.expiresAt-va.issuedAt,180);
 assert.deepEqual(Object.keys(va).sort(),['connections','display','expiresAt','issuedAt','ownerHint','schema'].sort());
 assert.doesNotMatch(JSON.stringify(va),/oauth:google-oauth2\|primary|obscuredPassword|rclone\.conf/);
});

test('snapshot rejects wrong secret, edited bits, expiry, future issuance and bad owner input',()=>{
 const snap=signStorageView('oauth:alice','Account',connections,key,10000);
 assert.throws(()=>verifyStorageView(snap,wrong,10001),/SIGNATURE_INVALID/);
 assert.throws(()=>verifyStorageView(snap+'A',key,10001),/TOKEN_INVALID/);
 assert.throws(()=>verifyStorageView(snap,key,10181),/EXPIRED_OR_INVALID/);
 assert.throws(()=>verifyStorageView(snap,key,9990),/EXPIRED_OR_INVALID/);
 assert.throws(()=>signStorageView('unverified','Account',connections,key,10000),/OWNER_REQUIRED/);
 assert.throws(()=>signStorageView('oauth:alice','Account',[{
   ...connections[0],providerVerified:['storage:permanent-delete']
 }],key,10000),/VIEW_INVALID/);
});

test('viewer is display-only and requires signed, distinct, caller-included owners',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','src/mcp/mcp.service.ts'),'utf8');
 assert.match(source,/registerTool\('nyx_account_view_snapshot'/);
 assert.match(source,/registerTool\('nyx_accounts_view'/);
 assert.match(source,/publicConnections=await this\.connections\.listStorage\(owner\)/);
 assert.match(source,/linkedRemotes=await privateRemotesForOwner\(owner\)/);
 assert.match(source,/verifyStorageView\(a\.snapshot,key\)/);
 assert.match(source,/NYX_ACCOUNT_VIEW_DUPLICATE_OWNER/);
 assert.match(source,/NYX_ACCOUNT_VIEW_CALLER_NOT_INCLUDED/);
 assert.match(source,/readOnly:true,noCrossTenantAuthorization:true/);
 assert.match(source,/ACCOUNT_VIEW_URI/);
 assert.equal(ACCOUNT_VIEW_URI,'ui://nestnyx/dev/connections/multi-v1.html');
 assert.match(ACCOUNT_VIEW_HTML,/role="tablist"/);
 assert.match(ACCOUNT_VIEW_HTML,/authenticated accounts loaded together/);
 assert.ok(ACCOUNT_VIEW_HTML.includes('envelope?.result??envelope'));
 assert.ok(ACCOUNT_VIEW_HTML.includes("v.label+' ('+v.connections.length+')'"));
 assert.match(ACCOUNT_VIEW_HTML,/Switching tabs changes only what you see/);
 assert.match(ACCOUNT_VIEW_HTML,/does not switch OAuth credentials/);
 assert.doesNotMatch(ACCOUNT_VIEW_HTML,/localStorage|sessionStorage|document\.cookie|fetch\(/);
 assert.doesNotMatch(ACCOUNT_VIEW_HTML,/window\.openai\.callTool|tools\/call/);
});
