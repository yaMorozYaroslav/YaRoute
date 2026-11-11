const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const panelModule=require.resolve('../dist/connectors/connections-panel');

function load(mode) {
  const original={mode:process.env.NYX_DEPLOYMENT_MODE,
    url:process.env.NYX_PUBLIC_URL,service:process.env.NYX_SERVICE_NAME,
    enabled:process.env.NYX_PUBLIC_CONNECTORS_ENABLED,
    rclone:process.env.NYX_MULTIUSER_RCLONE_ENABLED};
  try {
    process.env.NYX_DEPLOYMENT_MODE=mode;
    process.env.NYX_PUBLIC_URL=mode==='public'?
      'https://dev-nest-nyx-0df80c227630.herokuapp.com':'https://nest-nyx-pro.example.com';
    process.env.NYX_SERVICE_NAME=mode==='public'?'NestNyxPublicPilot':'NestNyxPro';
    process.env.NYX_PUBLIC_CONNECTORS_ENABLED=mode==='public'?'true':'false';
    process.env.NYX_MULTIUSER_RCLONE_ENABLED=mode==='public'?'true':'false';
    delete require.cache[panelModule];
    return require(panelModule);
  } finally {
    for(const [key,value] of Object.entries({
      NYX_DEPLOYMENT_MODE:original.mode,NYX_PUBLIC_URL:original.url,
      NYX_SERVICE_NAME:original.service,
      NYX_PUBLIC_CONNECTORS_ENABLED:original.enabled,
      NYX_MULTIUSER_RCLONE_ENABLED:original.rclone,
    })) {
      if(value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
    delete require.cache[panelModule];
  }
}
function inspectHtml(html,expectedName){
  assert.match(html,/^<!doctype html>/i);
  assert.match(html,/<html lang="en">/);
  assert.match(html,/<\/html>/);
  assert.match(html,/<title>[^<]+<\/title>/);
  assert.match(html,new RegExp(expectedName));
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1,'A single inline browser script should be present');
  assert.ok(scripts[0][1].length>1000,'script should contain full UI bridge');
  // The exact generated JavaScript must compile as a browser script; text
  // searches of the TypeScript source cannot detect broken template syntax.
  assert.doesNotThrow(()=>new vm.Script(scripts[0][1],{filename:'nestnyx-mcp-app-inline.js'}));
  for(const id of ['nyx-add','tenant-mega-add','tenant-mega-create','tenant-mega-list',
    'nyx-mega-list','message','refresh']) {
    assert.ok(html.includes('id="'+id+'"'),'missing required element: '+id);
  }
  assert.match(scripts[0][1],/ui\/initialize/);
  assert.match(scripts[0][1],/ui\/notifications\/initialized/);
  assert.match(scripts[0][1],/tools\/call/);
}
test('Dev and Pro MCP Apps Home and Connections embed valid JavaScript',()=>{
  for(const mode of ['public','private']){
    const panel=load(mode);
    for(const [html,name] of [[panel.CONNECTIONS_PANEL_HTML,'Connections'],
      [panel.CONNECTIONS_HOME_HTML,'Home']]) inspectHtml(html,name);
    assert.notEqual(panel.CONNECTIONS_PANEL_URI,panel.CONNECTIONS_HOME_URI);
  }
});
