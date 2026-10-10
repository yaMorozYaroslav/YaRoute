const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {GithubReadonlyConnector}=require('../dist/connectors/github-readonly');

const installed={
 id:'conn-github',ownerId:'oauth:test',displayName:'My source',
 provider:'github',externalAccountId:'example',installationId:'9876',
 status:'active',
 capabilities:['resources:read','releases:read','issues:read','pulls:read','repository:metadata'],
 providerCapabilities:['resources:read','releases:read','issues:read','pulls:read','repository:metadata'],
 resources:[{kind:'repository',id:'example/repo',
   capabilities:['resources:read','releases:read','issues:read','pulls:read','repository:metadata'],
   branches:['main']}],
};
const registry=new ConnectorRegistry({
 get:async id=>id===installed.id?installed:null,
 list:async()=>[installed],save:async()=>{},
});
function api(result){
 let calls=0;
 const issued=[];
 const requests=[];
 const connector=new GithubReadonlyConnector(registry,{
  tokenFor:async (...args)=>{issued.push(args);return 'example-token';},
 },async(url,init)=>{
  requests.push({url,method:init.method,headers:init.headers,redirect:init.redirect});
  calls++;
  return {ok:true,text:async()=>JSON.stringify(result)};
 });
 return {connector,issued,requests,get calls(){return calls;}};
}

test('GitHub commits are bounded and branch-scoped without allowing any writes',async()=>{
 const t=api([{sha:'abcd',commit:{message:'Refactor\nNext line',committer:{date:'2026-10-10'}},html_url:'https://github.com/example/repo/commit/abcd'}]);
 const records=await t.connector.commits('oauth:test','conn-github','example/repo','main');
 assert.equal(records.length,1);
 assert.equal(records[0].summary,'Refactor');
 assert.equal(t.requests[0].method,'GET');
 assert.equal(t.requests[0].redirect,'error');
 assert.match(t.requests[0].url,/\/commits\?per_page=25&sha=main$/);
 assert.deepEqual(t.issued[0].slice(0,5),['oauth:test','conn-github','9876','example/repo','resources:read']);
 assert.equal(t.issued[0][5].branch,'main');
 await assert.rejects(()=>t.connector.commits('oauth:test','conn-github','example/repo','feature'),
  /CONNECTOR_RESOURCE_FORBIDDEN/);
 assert.equal(t.calls,1);
});

test('GitHub contents respects selected path and selected branch',async()=>{
 const encoded=Buffer.from('Simple documentation').toString('base64');
 const t=api({type:'file',size:20,encoding:'base64',content:encoded,path:'docs/readme.md',sha:'ab'});
 const result=await t.connector.fileText('oauth:test','conn-github','example/repo','docs/readme.md','main');
 assert.equal(result.text,'Simple documentation');
 assert.equal(t.issued[0][5].path,'docs/readme.md');
 await assert.rejects(()=>t.connector.fileText('oauth:test','conn-github','example/repo','../.env','main'),
  /GITHUB_PATH_INVALID/);
 await assert.rejects(()=>t.connector.fileText('oauth:intruder','conn-github','example/repo','docs/readme.md','main'),
  /CONNECTOR_NOT_FOUND/);
 assert.equal(t.calls,1);
});

test('GitHub release list fails closed on branch-only grants',async()=>{
 const t=api([{id:1,name:'Version 1',tag_name:'v1',draft:false,prerelease:false}]);
 await assert.rejects(()=>t.connector.releases('oauth:test','conn-github','example/repo'),
   /CONNECTOR_RESOURCE_FORBIDDEN/);
 assert.equal(t.calls,0);
});

test('GitHub read-only API has no mutable command entrypoint',async()=>{
 const t=api([]);
 assert.equal(typeof t.connector.push,'undefined');
 assert.equal(typeof t.connector.workflowDispatch,'undefined');
 assert.equal(typeof t.connector.createRelease,'undefined');
});
