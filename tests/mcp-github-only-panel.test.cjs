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
 assert.match(panel,/ui:\/\/nestnyx\/pro\/connections\/v9\.html/);
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

test('ChatGPT gets separate authenticated conversation-tab and global-sidebar launchers',()=>{
 const mcp=src('src/mcp/mcp.service.ts');
 const thread=mcp.slice(mcp.indexOf("server.registerTool('nyx_connections_panel'"),
   mcp.indexOf("server.registerTool('nyx_connections_home'"));
 const global=mcp.slice(mcp.indexOf("server.registerTool('nyx_connections_home'"),
   mcp.indexOf("server.registerTool('nyx_connections_list'"));
 assert.ok(thread.startsWith("server.registerTool('nyx_connections_panel'"));
 assert.ok(global.startsWith("server.registerTool('nyx_connections_home'"));
 assert.ok(thread.includes("'openai/ui':{entrypoints:[{type:'thread'}]}"));
 assert.ok(global.includes("'openai/ui':{entrypoints:[{type:'global'}]}"));
 assert.ok(thread.includes("title:'☁️ NestNyx Pro Connections · Chat'"));
 assert.ok(global.includes("title:'☁️ NestNyx Pro Connections · Home'"));
 for(const tool of [thread,global]){
   assert.ok(tool.includes("inputSchema:z.object({})"));
   assert.ok(tool.includes("'openai/outputTemplate':CONNECTIONS_PANEL_URI"));
   assert.ok(tool.includes("ui:{resourceUri:CONNECTIONS_PANEL_URI"));
   assert.ok(tool.includes("annotations:{readOnlyHint:true,destructiveHint:false"));
   assert.ok(tool.includes("},connectionsPanelResult);"));
 }
 assert.ok(mcp.includes("const ownerId = this.connectorOwner()"));
 assert.ok(mcp.includes("connections:await this.connections.list(ownerId)"));
 assert.ok(mcp.includes("providers:[{id:'github'"));
 assert.ok(!mcp.includes("entrypoints:[{type:'global'},{type:'thread'}]"));
 // This production change intentionally does not expose unfinished public storage.
 assert.ok(mcp.includes("Google Drive and MEGA migration remains under separate review"));
});

test('green add menu is accessible and provider lists stay visible when closed',()=>{
 const panel=src('src/connectors/connections-panel.ts');
 for(const id of ['nyx-add','nyx-add-menu','nyx-google-group','nyx-mega-group',
    'nyx-rclone-group','nyx-other-group','nyx-google-count','nyx-mega-count',
    'nyx-rclone-count','nyx-other-count','new-github-container']){
   assert.ok(panel.includes('id="'+id+'"'),id);
 }
 assert.match(panel,/id="nyx-add"[^>]*aria-expanded="false"/);
 assert.match(panel,/id="nyx-add"[^>]*aria-controls="nyx-add-menu"/);
 assert.match(panel,/addMenu\.hidden=!addMenu\.hidden/);
 assert.ok(panel.indexOf('id="nyx-add-menu"')<panel.indexOf('id="nyx-google-group"'));
 assert.ok(panel.indexOf('id="nyx-google-group"')<panel.indexOf('id="nyx-other-group"'));
 assert.match(panel,/document\.getElementById\('nyx-other-count'\)\.textContent/);
});
test('existing MEGA and Drive remotes use read-only private inventory, never credential forms',()=>{
 const panel=src('src/connectors/connections-panel.ts');
 const mcp=src('src/mcp/mcp.service.ts');
 assert.match(panel,/call\('nyx_rclone_connections_list',\{\}\)/);
 assert.match(panel,/data\?\.status!=='configured_not_live_verified'/);
 assert.match(panel,/el\('strong',remote\.name\)/);
 assert.match(panel,/Connectivity: /);
 assert.match(panel,/Write access: Not tested/);
 assert.match(panel,/Test connection/);
 assert.match(panel,/nyx_rclone_connection_test_read/);
 assert.match(panel,/New Google Drive\/MEGA authorization is not enabled in production/);
 assert.doesNotMatch(panel,/nyx_connection_create.{0,180}provider:.*mega/s);
 assert.doesNotMatch(panel,/type="password"/);
 assert.match(mcp,/provider:z\.literal\('github'\)/);
 assert.match(src('src/connectors/connectors.service.ts'),/provider !== 'github'/);
});
