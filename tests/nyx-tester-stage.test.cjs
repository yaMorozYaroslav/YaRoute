const {test}=require('node:test');
const assert=require('node:assert/strict');
const SHA='a'.repeat(40),DST='b'.repeat(40),C='c'.repeat(40);
const blob=(path,sha)=>({path,sha,type:'blob'});
let m;
test('load staging module without making network requests',async()=>{
 m=await import('../scripts/nyx-tester-stage.mjs');
 assert.equal(typeof m.candidatePaths,'function');
});
test('candidate preserves target-owned configuration, workflows and regression tests',()=>{
 const source={truncated:false,tree:[
  blob('src/mcp/mcp.service.ts',SHA),blob('tests/tenant-rclone-auth.test.cjs',SHA),
  blob('tests/github-api-writes.test.cjs',SHA),blob('tests/branding.test.cjs',SHA),
  blob('scripts/install-rclone.mjs',SHA),blob('app.json',SHA),
  blob('.github/workflows/ci.yml',SHA),blob('config/nyx-runtime-profile.json',SHA)]};
 const target={truncated:false,tree:[
  blob('src/mcp/mcp.service.ts',DST),blob('tests/github-api-writes.test.cjs',DST)]};
 const p=m.candidatePaths(source,target);
 assert.deepEqual(p.map(x=>x.path),['src/mcp/mcp.service.ts','tests/tenant-rclone-auth.test.cjs']);
 assert.equal(p[0].targetBlob,DST);
 assert.equal(p[1].targetBlob,null);
});
test('all refs and candidate inputs are SHA-pinned and never permit target-owned paths',()=>{
 const input={sourceSha:SHA,testerSha:DST,sourceRef:SHA,testerRef:DST,masterRef:C,
  paths:[{path:'src/main.ts'}]};
 assert.equal(m.validateCandidate(input),true);
 assert.throws(()=>m.validateCandidate({...input,testerRef:SHA}),/BRANCH_MOVED/);
 assert.throws(()=>m.validateCandidate({...input,paths:[{path:'app.json'}]}),/TARGET_OWNED_FILE/);
 assert.throws(()=>m.validateCandidate({...input,paths:[]}),/FILES_INVALID/);
});
test('reviewed MCP adapter preserves short generic working branches and special staging tools',()=>{
 const handler=(name)=>"server.registerTool('"+name+"',{title:'Create a NYX GitHub review branch',description:'Review nyx/* branches',inputSchema:z.object({branch:z.string().min(5).max(100)}),annotations:{}});\n";
 const src=handler('nyx_connection_github_branch_create')+
   handler('nyx_connection_github_commit_file')+
   handler('nyx_connection_github_draft_pr')+
   handler('nyx_connection_github_issue_create');
 const result=m.adaptMcpForTester(src);
 assert.equal((result.match(/branch:z\.string\(\)\.min\(1\)\.max\(100\)/g)||[]).length,3);
 assert.equal((result.match(/branch:z\.string\(\)\.min\(5\)\.max\(100\)/g)||[]).length,1);
 assert.equal(result.slice(0,result.indexOf("server.registerTool('nyx_connection_github_issue_create'")).includes('nyx/*'),false);
 assert.match(result,/main\/master\/default/);
});
test('incomplete tree or unexpected schema stops planning',()=>{
 assert.throws(()=>m.candidatePaths({truncated:true,tree:[]},{truncated:false,tree:[]}),/TRUNCATED_TREE/);
 assert.throws(()=>m.adaptMcpForTester('some untrusted code'),/MCP_SOURCE_INVALID/);
});
