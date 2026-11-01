const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {herokuReadAuthorization}=require('../dist/connectors/heroku-read-policy');

const OWNER='oauth:owner-only',ID='11111111-1111-4111-8111-111111111111';
const configured={
 NYX_HEROKU_READ_ENABLED:'true',NYX_HEROKU_READ_OWNER:OWNER,
 NYX_HEROKU_READ_CONNECTION_ID:ID,
 NYX_HEROKU_READ_APPS:'dev-nest-nyx,existing-private-app',
 NYX_HEROKU_BROKER_URL:'https://isolated-broker.example.invalid',
 NYX_HEROKU_BROKER_SHARED_KEY:'z'.repeat(48),
};
test('Heroku read policy permits only exact authenticated owner and named app',()=>{
 const r=herokuReadAuthorization(OWNER,'dev-nest-nyx',configured);
 assert.deepEqual(r,{ownerId:OWNER,connectionId:ID,app:'dev-nest-nyx'});
 for(const owner of ['oauth:another','',OWNER+'-fake'])
  assert.throws(()=>herokuReadAuthorization(owner,'dev-nest-nyx',configured),
    /HEROKU_READ_OWNER_OR_APP_FORBIDDEN/);
 for(const app of ['pro-secret','dev-nest-nyx/../logs','dev-nest-nyx/config-vars',''])
  assert.throws(()=>herokuReadAuthorization(OWNER,app,configured),
    /HEROKU_READ_OWNER_OR_APP_FORBIDDEN/);
});
test('read-only bridge fails closed on missing flags, invalid grant maps or no broker',()=>{
 const cases=[
  {NYX_HEROKU_READ_ENABLED:'false'},
  {NYX_HEROKU_READ_OWNER:'oauth:someone-else'},
  {NYX_HEROKU_READ_OWNER:'owner-without-oauth'},
  {NYX_HEROKU_READ_CONNECTION_ID:'untrusted'},
  {NYX_HEROKU_READ_APPS:'dev-nest-nyx,dev-nest-nyx'},
  {NYX_HEROKU_READ_APPS:'*'},
  {NYX_HEROKU_READ_APPS:''},
  {NYX_HEROKU_BROKER_URL:''},
  {NYX_HEROKU_BROKER_SHARED_KEY:''},
 ];
 for(const change of cases){
  const env={...configured,...change};
  assert.throws(()=>herokuReadAuthorization(OWNER,'dev-nest-nyx',env),/HEROKU_/);
 }
});
test('public MCP reads only app info and bounded release metadata, never config or writes',()=>{
 const mcp=readFileSync('src/mcp/mcp.service.ts','utf8');
 const start=mcp.indexOf("server.registerTool('nyx_heroku_app_info'");
 const second=mcp.indexOf("server.registerTool('nyx_heroku_releases'",start);
 const end=mcp.indexOf('// Public multi-user connector mode',second);
 assert.ok(start>0&&second>start&&end>second);
 const section=mcp.slice(start,end);
 assert.match(section,/herokuReadAuthorization\(this\.connectorOwner\(\),app\)/);
 assert.match(section,/this\.herokuBroker\.appInfo/);
 assert.match(section,/this\.herokuBroker\.releases/);
 assert.match(section,/readOnlyHint:true/);
 assert.doesNotMatch(section,/(?:config:set|config:unset|HEROKU_API_KEY|herokuBroker\.configNames|herokuBroker\.deploy|herokuBroker\.write)/);
 const gate=mcp.lastIndexOf("if (process.env.NYX_HEROKU_READ_ENABLED === 'true')",start);
 assert.ok(gate>=0&&gate<start);
});
