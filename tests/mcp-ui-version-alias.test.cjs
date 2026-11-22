const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compatibilityResourceUri}=require('../dist/mcp/mcp-ui-version');

test('v16 Dev and Pro Connections/Home aliases resolve all cached v10-v15 resources',()=>{
 for(const deployment of ['dev','pro']){
  for(const page of ['connections','home']){
   const uri='ui://nestnyx/'+deployment+'/'+page+'/v16.html';
   for(const version of [10,11,12,13,14,15]){
    assert.equal(compatibilityResourceUri(uri,version),
      'ui://nestnyx/'+deployment+'/'+page+'/v'+version+'.html');
   }
  }
 }
});

test('resource aliases reject unchanged, unversioned and invalid target URIs',()=>{
 assert.throws(()=>compatibilityResourceUri('ui://nestnyx/dev/connections/v16.html',16),
   /NYX_MCP_UI_ALIAS_URI_INVALID/);
 assert.throws(()=>compatibilityResourceUri('ui://nestnyx/dev/connections/home',14),
   /NYX_MCP_UI_ALIAS_URI_INVALID/);
 assert.throws(()=>compatibilityResourceUri('ui://nestnyx/dev/connections/v16.html',0),
   /NYX_MCP_UI_ALIAS_VERSION_INVALID/);
});

test('the MCP server uses validated dynamic alias construction, not hardcoded v14',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');
 assert.match(source,/const oldUri=compatibilityResourceUri\(item\.uri,version\)/);
 assert.doesNotMatch(source,/oldUri=item\.uri\.replace\(/);
});
