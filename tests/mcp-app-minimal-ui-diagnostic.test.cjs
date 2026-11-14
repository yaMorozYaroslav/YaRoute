const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');

test('read-only UI diagnostic has one fresh URI and registered tool',()=>{
 assert.match(source,/const diagnosticUi='ui:\/\/nestnyx\/diagnostic\/v1\.html'/);
 assert.match(source,/server\.registerResource\('NestNyx UI Diagnostic',diagnosticUi/);
 assert.match(source,/server\.registerTool\('nyx_ui_diagnostic'/);
 assert.match(source,/uri:diagnosticUi,mimeType:'text\/html;profile=mcp-app'/);
 assert.match(source,/'openai\/outputTemplate':diagnosticUi/);
 assert.match(source,/ui:\{resourceUri:diagnosticUi,visibility:\['model','app'\]\}/);
});
test('diagnostic requires no credentials, network, storage, or client JavaScript',()=>{
 const start=source.indexOf('const diagnosticUi=');
 const end=source.indexOf('// Capability discovery is advisory:',start);
 assert.ok(start>=0&&end>start);
 const region=source.slice(start,end);
 assert.doesNotMatch(region,/<script|fetch\(|window\.|document\.|RCLONE_CONFIG|authorization|process\.env/i);
 assert.match(region,/noCredentialsRead:true,noStorageAccess:true/);
 assert.match(region,/connectDomains:\[\],resourceDomains:\[\]/);
 assert.match(region,/readOnlyHint:true,destructiveHint:false/);
});

test('cached v10-v12 Connections and Home URLs remain available with v13 UI',()=>{
 assert.match(source,/legacyConnectionsResourceUri='ui:\/\/nestnyx\/connections\/v9\.html'/);
 assert.match(source,/for \(const version of \[10,11,12\]\)/);
 assert.match(source,/CONNECTIONS_PANEL_URI,html:CONNECTIONS_PANEL_HTML/);
 assert.match(source,/CONNECTIONS_HOME_URI,html:CONNECTIONS_HOME_HTML/);
 assert.match(source,/oldUri=item\.uri\.replace\(/);
 assert.match(source,/server\.registerResource\(item\.label\+' \(compatibility v'/);
 assert.match(source,/uri:oldUri,mimeType:'text\/html;profile=mcp-app',text:item\.html/);
 assert.match(source,/connectDomains:\[\]/);
 assert.match(source,/resourceDomains:CONNECTIONS_PANEL_BRAND_ORIGIN/);
 assert.doesNotMatch(source,/\bregisterResource\([^;]*global\.rcloneConfig/s);
});
