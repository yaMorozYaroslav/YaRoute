const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorRegistry,suggestConnectionName}=require('../dist/connectors/connector-registry');
const {GitOperationPlanner}=require('../dist/connectors/git-operation-plan');
const {HerokuOperationPlanner}=require('../dist/connectors/heroku-operation-plan');

function registry(item){
 const repo={get:async id=>id===item.id?item:null,list:async()=>[item],save:async()=>{}};
 return new ConnectorRegistry(repo);
}
test('user-defined names and old names as optional placeholders',()=>{
 assert.equal(suggestConnectionName('google-drive',[]),'google_main');
 assert.equal(suggestConnectionName('google-drive',['google_main']),'google_work');
 assert.equal(suggestConnectionName('mega',[]),'mega_main');
 assert.equal(suggestConnectionName('github',[]),'GitHub');
});
test('Git plans require resource grants and never execute themselves',async()=>{
 const r=registry({id:'g',ownerId:'oauth:u',displayName:'Git',
 provider:'github',externalAccountId:'account',status:'active',
 capabilities:['git:inspect'],providerCapabilities:['git:inspect'],
 resources:[{kind:'repository',id:'org/repo',capabilities:['git:inspect'],branches:['master']}]});
 const p=new GitOperationPlanner(r);
 await assert.rejects(()=>p.plan('oauth:u','g','status','org/repo','master'),
  /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/);
 await assert.rejects(()=>p.plan('oauth:u','g','push','org/repo','master'),
  /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/);
});
test('Heroku planning separates read-only and approval-required actions',async()=>{
 const item={id:'h',ownerId:'oauth:u',displayName:'Heroku',provider:'heroku',
 externalAccountId:'account',status:'active',capabilities:['heroku:apps:read','heroku:deploy'],
 providerCapabilities:['heroku:apps:read','heroku:deploy'],
 resources:[{kind:'heroku-app',id:'example-app',capabilities:['heroku:apps:read','heroku:deploy']}]};
 const planner=new HerokuOperationPlanner(registry(item));
 assert.equal((await planner.plan('oauth:u','h','app.info','example-app')).approvalRequired,false);
 assert.equal((await planner.plan('oauth:u','h','app.deploy','example-app')).approvalRequired,true);
 await assert.rejects(()=>planner.plan('oauth:u','h','app.info','unrelated-app'),/CONNECTOR_RESOURCE_FORBIDDEN/);
});
