const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function src(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

test('MCP Apps panel has versioned UI and ChatGPT metadata',()=>{
 const mcp=src('src/mcp/mcp.service.ts');
 const panel=src('src/connectors/connections-panel.ts');
 assert.match(mcp,/server\.registerTool\('nyx_connections_panel'/);
 assert.match(mcp,/'openai\/outputTemplate':CONNECTIONS_PANEL_URI/);
 assert.match(panel,/ui:\/\/nestnyx\/connections\/v6\.html/);
 assert.match(mcp,/text\/html;profile=mcp-app/);
});

test('only GitHub connection and repository resource schemas are exposed',()=>{
 const mcp=src('src/mcp/mcp.service.ts');
 const panel=src('src/connectors/connections-panel.ts');
 const service=src('src/connectors/connectors.service.ts');
 assert.match(mcp,/provider:z\.literal\('github'\)/);
 assert.match(mcp,/kind:z\.literal\('repository'\)/);
 assert.doesNotMatch(mcp,/nyx_connection_(?:verify_heroku|heroku_info|heroku_releases)/);
 assert.doesNotMatch(panel,/<option value="heroku"/);
 assert.doesNotMatch(panel,/call\('nyx_connection_verify_heroku'/);
 assert.match(service,/provider !== 'github'/);
 assert.doesNotMatch(src('src/connectors/connectors.module.ts'),/HerokuReadonlyConnector|HerokuBrokerClient/);
});

test('MCP panel is auxiliary and does not modify Head CLI definitions',()=>{
 const mcp=src('src/mcp/mcp.service.ts');
 assert.match(mcp,/canonical Head\/LEAD\/Core_Skills\/YaRoCLI\/nyxcli\.json/);
 assert.match(mcp,/nyx_connections_panel/);
 assert.match(mcp,/not all Head commands guaranteed/);
});

test('Google OAuth release retains separate ChatGPT tab and global sidebar launchers',()=>{
 const mcp=src('src/mcp/mcp.service.ts');
 const tab=mcp.slice(mcp.indexOf("server.registerTool('nyx_connections_panel'"),
   mcp.indexOf("server.registerTool('nyx_connections_home'"));
 const home=mcp.slice(mcp.indexOf("server.registerTool('nyx_connections_home'"),
   mcp.indexOf("server.registerTool('nyx_connections_list'"));
 assert.ok(tab.startsWith("server.registerTool('nyx_connections_panel'"));
 assert.ok(home.startsWith("server.registerTool('nyx_connections_home'"));
 assert.ok(tab.includes("'openai/ui':{entrypoints:[{type:'thread'}]}"));
 assert.ok(home.includes("'openai/ui':{entrypoints:[{type:'global'}]}"));
 for(const item of [tab,home]){
   assert.ok(item.includes("ui:{resourceUri:CONNECTIONS_PANEL_URI"));
   assert.ok(item.includes("'openai/outputTemplate':CONNECTIONS_PANEL_URI"));
   assert.ok(item.includes("},connectionsPanelResult);"));
   assert.ok(item.includes("readOnlyHint:true"));
 }
 assert.ok(mcp.includes("const ownerId = this.connectorOwner()"));
 assert.ok(mcp.includes("connections:await this.connections.list(ownerId)"));
 assert.ok(mcp.includes("'nyx_connections_home'"));
});
test('green plus offers direct Google OAuth while legacy Rclone is private',()=>{
 const panel=src('src/connectors/connections-panel.ts');
 const mcp=src('src/mcp/mcp.service.ts');
 assert.match(panel,/id="nyx-add"/);
 assert.match(panel,/data-provider="google-drive"/);
 assert.match(panel,/Google Drive · Sign in with Google/);
 assert.match(panel,/nyx_rclone_connection_begin_google/);
 assert.match(mcp,/server\.registerTool\('nyx_rclone_connection_begin_google'/);
 assert.match(mcp,/this\.connections\.beginGoogleDrive\(this\.connectorOwner\(\),id\)/);
 assert.ok(mcp.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;") <
           mcp.indexOf("server.registerTool('nyx_rclone_connections_list'"));
});
