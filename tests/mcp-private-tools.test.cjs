const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const source=()=>readFileSync(join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');

test('previously advertised private NYX MCP read tools are registered',()=>{
 const mcp=source();
 const privateGate=mcp.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;");
 assert.ok(privateGate>0);
 for(const tool of ['nyx_head_status','nyx_areas','nyx_list','nyx_stat','nyx_capacity','nyx_job_status']){
  const occurrence="server.registerTool('"+tool+"'";
  assert.equal(mcp.split(occurrence).length-1,1,tool+' must be registered exactly once');
  assert.ok(mcp.indexOf(occurrence)>privateGate,tool+' must be private only');
 }
});

test('MCP helpers reuse existing verified NYX services, not invented Head commands',()=>{
 const mcp=source();
 assert.match(mcp,/this\.bootstrap\.locate\(\)/);
 assert.match(mcp,/this\.cliRegistry\.current\(locator\)/);
 assert.match(mcp,/this\.headLibrary\.snapshot\(\)/);
 for(const expr of [
  'this.storage.areas()',
  'this.storage.list(area,path)',
  'this.storage.stat(area,path)',
  'this.storage.capacity()',
  'this.jobs.get(id)',
 ]){
  assert.ok(mcp.includes(expr),'missing existing backend delegation: '+expr);
 }
 assert.match(mcp,/source_of_truth:'canonical Head bundle'/);
 assert.match(mcp,/These are MCP auxiliaries and must not/);
});

test('exposed NYX job status handles missing jobs without queueing work',()=>{
 const mcp=source();
 const begin=mcp.indexOf("server.registerTool('nyx_job_status'");
 const end=mcp.indexOf("server.registerTool(",begin+20);
 const tool=mcp.slice(begin,end);
 assert.match(tool,/readOnlyHint:true/);
 assert.match(tool,/if\(!job\)throw new Error\('JOB_NOT_FOUND'\)/);
 assert.doesNotMatch(tool,/createCopy|createGlobalIndex|succeed\(|fail\(/);
});

test('scope of new compatibility tools does not mutate core NYX files',()=>{
 const mcp=source();
 const section=mcp.slice(mcp.indexOf("server.registerTool('nyx_head_status'"),
   mcp.indexOf("server.registerTool(\n      'nyx_execute'"));
 assert.doesNotMatch(section,/this\.commands\.execute|this\.jobs\.create|this\.storage\.executeCopy|this\.rclone\.run/);
 assert.match(mcp,/CONNECTIONS_PANEL_URI/);
 assert.match(mcp,/nyx_rclone_connections_list/);
});
