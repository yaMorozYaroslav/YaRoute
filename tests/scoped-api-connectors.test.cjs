const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectorRegistry } = require('../dist/connectors/connector-registry');
const { GithubReadonlyConnector } = require('../dist/connectors/github-readonly');
const { HerokuBrokerClient } = require('../dist/connectors/heroku-broker.client');

const conn={
 id:'user-conn',ownerId:'oauth:alice',provider:'github',
 displayName:'Team',externalAccountId:'team',installationId:'42',
 status:'active',
 capabilities:['repository:metadata','issues:read','pulls:read','resources:read'],
 providerCapabilities:['repository:metadata','issues:read','pulls:read','resources:read'],
 resources:[{kind:'repository',id:'team/service',capabilities:[
   'repository:metadata','issues:read','pulls:read','resources:read',
 ]}],
};
function connector(http){
 const registry=new ConnectorRegistry({get:async()=>conn,list:async()=>[conn],save:async()=>{}});
 const issued=[];
 return {
  issued,
  api:new GithubReadonlyConnector(registry,{
    tokenFor:async(owner,id,install,repo,cap)=>{
      issued.push({owner,id,install,repo,cap});
      return 'mock-restricted-token';
    },
  },http),
 };
}
function reply(data){return{ok:true,status:200,text:async()=>JSON.stringify(data)};}
test('GitHub repository and issue reads use capability-specific tokens',async()=>{
 const paths=[];
 const {issued,api}=connector(async(url,options)=>{
   paths.push(url);assert.equal(options.method,'GET');
   if(url.endsWith('/issues?state=open&per_page=30'))return reply([
    {number:1,title:'Review issue',state:'open',labels:[{name:'bug'}]},
    {number:2,pull_request:{url:'...'},title:'PR not issue'},
   ]);
   return reply({full_name:'team/service',default_branch:'main',private:true});
 });
 assert.deepEqual((await api.repository('oauth:alice','user-conn','team/service')).fullName,'team/service');
 const issues=await api.issues('oauth:alice','user-conn','team/service');
 assert.equal(issues.length,1);assert.equal(issues[0].number,1);
 assert.deepEqual(issued.map(x=>x.cap),['repository:metadata','issues:read']);
 await assert.rejects(()=>api.issues('oauth:bob','user-conn','team/service'),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>api.issues('oauth:alice','user-conn','another/repo'),/CONNECTOR_RESOURCE_FORBIDDEN/);
 assert.equal(issued.length,2);
});
test('GitHub file read enforces path, ref and size limits before returning content',async()=>{
 const {api}=connector(async()=>reply({
  type:'file',path:'src/index.ts',size:13,sha:'123',encoding:'base64',
  content:Buffer.from('hello-world!').toString('base64'),
 }));
 const f=await api.fileText('oauth:alice','user-conn','team/service','src/index.ts','main');
 assert.equal(f.text,'hello-world!');
 await assert.rejects(()=>api.fileText('oauth:alice','user-conn','team/service','../.env','main'),
   /GITHUB_PATH_INVALID/);
 await assert.rejects(()=>api.fileText('oauth:alice','user-conn','team/service','ok','../evil'),
   /GITHUB_BRANCH_INVALID/);
});
test('Heroku broker client uses fixed, signed read endpoint only',async()=>{
 const oldFetch=global.fetch;
 const backup={...Object.fromEntries(['NYX_HEROKU_BROKER_URL','NYX_HEROKU_BROKER_SHARED_KEY']
  .map(k=>[k,process.env[k]]))};
 process.env.NYX_HEROKU_BROKER_URL='https://read-broker.example.org';
 process.env.NYX_HEROKU_BROKER_SHARED_KEY='a'.repeat(40);
 try {
  let captured;
  global.fetch=async(url,options)=>{
   captured={url,options};
   return{ok:true,text:async()=>JSON.stringify({
    name:'safe-app',id:'some-id',region:'eu',web_url:'https://safe-app.example.org',
    billing:'THIS MUST NOT LEAVE BROKER',
   })};
  };
  const result=await new HerokuBrokerClient().appInfo('oauth:alice',
    '123e4567-e89b-12d3-a456-426614174000','safe-app');
  assert.equal(result.name,'safe-app');
  assert.equal(Object.hasOwn(result,'billing'),false);
  assert.equal(captured.url,'https://read-broker.example.org/v1/read');
  assert.equal(captured.options.method,'POST');
  assert.ok(captured.options.headers['x-nyx-signature']);
  assert.deepEqual(JSON.parse(captured.options.body),
    {ownerId:'oauth:alice',connectionId:'123e4567-e89b-12d3-a456-426614174000',
      app:'safe-app',operation:'app.info'});
 }finally{
  global.fetch=oldFetch;
  for(const[k,v]of Object.entries(backup))v===undefined?delete process.env[k]:process.env[k]=v;
 }
});
