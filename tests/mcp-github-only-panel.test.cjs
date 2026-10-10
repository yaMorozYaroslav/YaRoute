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
 assert.match(panel,/ui:\/\/nestnyx\/connections\/v2\.html/);
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
