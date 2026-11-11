const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');

const modulePath=require.resolve('../dist/connectors/connections-panel');
const keys=['NYX_DEPLOYMENT_MODE','NYX_SERVICE_NAME','NYX_PUBLIC_URL',
  'NYX_PUBLIC_CONNECTORS_ENABLED','NYX_MULTIUSER_RCLONE_ENABLED'];
function view(mode,service,url){
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  process.env.NYX_DEPLOYMENT_MODE=mode;
  process.env.NYX_SERVICE_NAME=service;
  process.env.NYX_PUBLIC_URL=url;
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED=mode==='public'?'true':'false';
  process.env.NYX_MULTIUSER_RCLONE_ENABLED=mode==='public'?'true':'false';
  delete require.cache[modulePath];
  const panel=require(modulePath);
  return {
    connectionsUri:panel.CONNECTIONS_PANEL_URI,
    homeUri:panel.CONNECTIONS_HOME_URI,
    connectionsLabel:panel.CONNECTIONS_PANEL_LABEL,
    homeLabel:panel.CONNECTIONS_HOME_LABEL,
    connectionsHtml:panel.CONNECTIONS_PANEL_HTML,
    homeHtml:panel.CONNECTIONS_HOME_HTML,
  };
 }finally{
  for(const [k,v] of Object.entries(saved))
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  delete require.cache[modulePath];
 }
}

test('blue Dev pilot and purple private Pro get distinct branded MCP Apps resource IDs',()=>{
 const dev=view('public','NestNyx','https://dev-nest-nyx-0df80c227630.herokuapp.com');
 const pro=view('private','NestNyx','https://example.com');
 assert.match(dev.connectionsUri,/\/dev\/connections\/v10\.html$/);
 assert.match(pro.connectionsUri,/\/pro\/connections\/v10\.html$/);
 assert.match(dev.homeUri,/\/dev\/home\/v10\.html$/);
 assert.match(pro.homeUri,/\/pro\/home\/v10\.html$/);
 assert.notEqual(dev.connectionsUri,pro.connectionsUri);
 assert.notEqual(dev.connectionsUri,dev.homeUri);
 assert.notEqual(pro.connectionsUri,pro.homeUri);
 assert.match(dev.connectionsLabel,/🔵 NestNyx Dev/);
 assert.match(pro.connectionsLabel,/🟣 NestNyx Pro/);
 assert.match(dev.homeLabel,/🏠 NestNyx Dev/);
 assert.match(pro.homeLabel,/🏠 NestNyx Pro/);
 assert.notEqual(dev.homeLabel,dev.connectionsLabel);
 assert.notEqual(pro.homeLabel,pro.connectionsLabel);
 assert.match(dev.connectionsHtml,/<title>NestNyx Dev · Connections<\/title>/);
 assert.match(pro.connectionsHtml,/<title>NestNyx Pro · Connections<\/title>/);
 assert.match(dev.homeHtml,/<title>NestNyx Dev · Home<\/title>/);
 assert.match(pro.homeHtml,/<title>NestNyx Pro · Home<\/title>/);
 assert.match(dev.homeHtml,/<span class="muted">Home<\/span>/);
 assert.match(dev.connectionsHtml,/<span class="muted">Connections<\/span>/);
 assert.match(dev.connectionsHtml,/\/branding\/icon\.png/);
 assert.match(pro.connectionsHtml,/\/branding\/icon\.png/);
});
