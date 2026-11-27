const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {safeCliPlan,SafeGithubCli}=require('../dist/connectors/github-cli-safe');

const flagNames=['NYX_GITHUB_CLI_PILOT_ENABLED','NYX_DEPLOYMENT_MODE',
  'NYX_PUBLIC_CONNECTORS_ENABLED'];
function pilot(t,enabled=true){
 const saved=Object.fromEntries(flagNames.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const [key,value] of Object.entries(saved)){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
 }});
 process.env.NYX_GITHUB_CLI_PILOT_ENABLED=enabled?'true':'false';
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
}
const connectionId='12345678-1234-4234-8234-123456789abc';
const repo='owner/repo',ownerA='oauth:google-oauth2|1111111111111',
 ownerB='oauth:google-oauth2|2222222222222';
function fixtures(t,tool='gh'){
 pilot(t);
 const calls={getOwned:0,grants:[],tokens:[],invocations:[]};
 const connections={
   getOwned:async(owner,id)=>{
     calls.getOwned++;
     if(owner!==ownerA||id!==connectionId)
       throw Error('CONNECTOR_NOT_FOUND');
     return {id:connectionId,ownerId:ownerA,provider:'github',
       status:'active',installationId:'1234'};
   },
   registryPolicy:()=>({requireResource:async(owner,id,cap,rule)=>{
     calls.grants.push({owner,id,cap,rule});
     if(owner!==ownerA||id!==connectionId||rule.id!==repo)
       throw Error('CONNECTOR_RESOURCE_FORBIDDEN');
     return {provider:'github'};
   }}),
 };
 const app={tokenFor:async(...args)=>{
   calls.tokens.push(args);
   return 'fixture-short-lived-app-token';
 }};
 const runner=async(binary,args,env)=>{
   calls.invocations.push({binary,args,env});
   return tool==='gh'
     ?JSON.stringify({full_name:repo,default_branch:'main',private:true})
     :'a'.repeat(40)+'\trefs/heads/main\n'+'b'.repeat(40)+'\trefs/heads/nyx/review\n';
 };
 const probe=new SafeGithubCli(connections,app,runner,()=>'/verified/fixture-binary');
 return {probe,calls};
}
test('Git CLI uses only fixed read-only argv and environment-only GitHub authorization',t=>{
 const token='fixture-short-lived-app-token';
 const p=safeCliPlan('git',repo,token,'/private/ephemeral');
 assert.deepEqual(p.args,['ls-remote','--heads','https://github.com/owner/repo.git']);
 assert.ok(!p.args.join(' ').includes(token));
 assert.equal(p.env.GIT_TERMINAL_PROMPT,'0');
 assert.equal(p.env.GIT_ALLOW_PROTOCOL,'https');
 assert.equal(p.env.GIT_CONFIG_KEY_0,'http.https://github.com/.extraheader');
 assert.ok(!JSON.stringify(p.args).includes('AUTHORIZATION'));
 assert.doesNotMatch(p.args.join(' '),/sh -c|;|--upload-pack/);
});
test('gh uses only fixed GitHub API argv and an isolated profile',()=>{
 const token='fixture-short-lived-app-token';
 const p=safeCliPlan('gh',repo,token,'/private/ephemeral');
 assert.deepEqual(p.args,['api','repos/owner/repo','--method','GET']);
 assert.equal(p.env.GH_TOKEN,token);
 assert.equal(p.env.HOME,'/private/ephemeral');
 assert.ok(!p.args.join(' ').includes(token));
 for(const bad of ['../evil','owner/repo/branch','owner/repo;rm','https://github.com/owner/repo','owner/..'])
   assert.throws(()=>safeCliPlan('gh',bad,token,'/tmp'),/GITHUB_CLI_REPOSITORY_INVALID/);
});
test('both typed Git and gh probes use the exact owner and selected repository',async t=>{
 const a=fixtures(t,'git');
 const git=await a.probe.probe(ownerA,connectionId,repo,'git');
 assert.equal(git.status,'verified');
 assert.equal(git.headCount,2);
 assert.deepEqual(git.sampleHeads,['main','nyx/review']);
 assert.deepEqual(a.calls.grants.map(x=>x.cap),['resources:read']);
 assert.equal(a.calls.tokens[0][4],'resources:read');
 assert.equal(a.calls.invocations[0].binary,'/verified/fixture-binary');
 const b=fixtures(t,'gh');
 const gh=await b.probe.probe(ownerA,connectionId,repo,'gh');
 assert.equal(gh.status,'verified');
 assert.equal(gh.defaultBranch,'main');
 assert.deepEqual(b.calls.grants.map(x=>x.cap),['repository:metadata']);
 assert.equal(b.calls.tokens[0][4],'repository:metadata');
});
test('cross-owner CLI probe is denied before token or process execution',async t=>{
 const a=fixtures(t,'gh');
 await assert.rejects(()=>a.probe.probe(ownerB,connectionId,repo,'gh'),/CONNECTOR_NOT_FOUND/);
 assert.equal(a.calls.tokens.length,0);
 assert.equal(a.calls.invocations.length,0);
});
test('unselected repo is denied before token or process execution',async t=>{
 const a=fixtures(t,'gh');
 await assert.rejects(()=>a.probe.probe(ownerA,connectionId,'someone/private','gh'),
  /CONNECTOR_RESOURCE_FORBIDDEN/);
 assert.equal(a.calls.tokens.length,0);
 assert.equal(a.calls.invocations.length,0);
});
test('disabled CLI pilot rejects even authenticated probe before all IO',async t=>{
 const a=fixtures(t,'gh');
 process.env.NYX_GITHUB_CLI_PILOT_ENABLED='false';
 await assert.rejects(()=>a.probe.probe(ownerA,connectionId,repo,'gh'),
   /GITHUB_CLI_PILOT_DISABLED/);
 assert.equal(a.calls.getOwned,0);
});
test('panel has separate Git/gh read-only probes without arbitrary command entrypoint',()=>{
 const panel=fs.readFileSync('src/connectors/connections-panel.ts','utf8');
 const mcp=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 assert.match(panel,/Add Git CLI \(read-only\)/);
 assert.match(panel,/Add gh CLI \(read-only\)/);
 assert.match(mcp,/nyx_connection_github_cli_probe/);
 assert.match(mcp,/new SafeGithubCli\(this.connections,this.githubApp\)/);
 assert.doesNotMatch(mcp,/registerTool\('nyx_connection_github_gh_exec'/);
 assert.doesNotMatch(mcp,/registerTool\('nyx_connection_git_exec'/);
});
test('oversize pull listing retries bounded smaller pages and returns summaries',async()=>{
 const {GithubReadonlyConnector}=require('../dist/connectors/github-readonly');
 const calls=[];
 const registry={requireResource:async()=>({
   provider:'github',installationId:'1234',
 })};
 const connector=new GithubReadonlyConnector(registry,{
   tokenFor:async()=> 'fixture-token',
 },async(url,opts)=>{
   calls.push(url);
   const perPage=Number(new URL(url).searchParams.get('per_page'));
   const body=perPage===10?JSON.stringify([{data:'X'.repeat(260000)}]):
     JSON.stringify([{number:1,title:'PR',state:'open',draft:true,
       html_url:'https://github.com/owner/repo/pull/1',
       head:{ref:'nyx/review'},base:{ref:'tester'}}]);
   return {ok:true,text:async()=>body};
 });
 const out=await connector.pullRequests(ownerA,connectionId,repo);
 assert.equal(out.length,1);
 assert.equal(out[0].title,'PR');
 assert.match(calls[0],/per_page=10/);
 assert.match(calls[1],/per_page=5/);
 assert.equal(calls.length,2);
});
