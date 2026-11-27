const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {GithubReadonlyConnector}=require('../dist/connectors/github-readonly');

function fixture({authorized=true,httpResult=[]}={}){
  const calls=[];
  const connection={
    id:'github-test',ownerId:'oauth:owner',displayName:'owner',
    provider:'github',externalAccountId:'owner',installationId:'123',
    status:'active',
    capabilities:authorized?['github:protection:read']:['repository:metadata'],
    providerCapabilities:authorized?['github:protection:read']:['repository:metadata'],
    resources:[{kind:'repository',id:'owner/repo',
      capabilities:authorized?['github:protection:read']:['repository:metadata']}],
  };
  const registry=new ConnectorRegistry({
    get:async id=>id===connection.id?connection:null,
    list:async()=>[connection],save:async()=>{},
  });
  const connector=new GithubReadonlyConnector(registry,{
    tokenFor:async(...args)=>{calls.push({tokenCapability:args[4]});return 'mock-token';},
  },async(url,options)=>{
    calls.push({url,method:options.method});
    return {ok:true,status:200,text:async()=>JSON.stringify(httpResult)};
  });
  return {connector,calls};
}

test('read-only rulesets require owner, exact repo, and explicit verified admin read',async()=>{
  const denied=fixture({authorized:false});
  await assert.rejects(()=>denied.connector.rulesets('oauth:owner','github-test','owner/repo'),/CONNECTOR_FORBIDDEN/);
  assert.equal(denied.calls.length,0);

  const good=fixture({httpResult:[{id:42,name:'master',enforcement:'active',target:'branch',source_type:'Repository'}]});
  const result=await good.connector.rulesets('oauth:owner','github-test','owner/repo');
  assert.deepEqual(result,[{id:42,name:'master',enforcement:'active',target:'branch',sourceType:'Repository'}]);
  assert.equal(good.calls[0].tokenCapability,'github:protection:read');
  assert.match(good.calls[1].url,/\/rulesets\?includes_parents=true&per_page=100$/);
  assert.equal(good.calls[1].method,'GET');
  await assert.rejects(()=>good.connector.rulesets('oauth:other','github-test','owner/repo'),/CONNECTOR_NOT_FOUND/);
  await assert.rejects(()=>good.connector.rulesets('oauth:owner','github-test','other/repo'),/CONNECTOR_RESOURCE_FORBIDDEN/);
  assert.equal(good.calls.length,2);
});

test('ruleset read validates numeric ID and cannot select arbitrary API URL',async()=>{
  const good=fixture({httpResult:{id:42,name:'master',enforcement:'active',target:'branch',rules:[],conditions:{}}});
  await assert.rejects(()=>good.connector.ruleset('oauth:owner','github-test','owner/repo',-1),/GITHUB_RULESET_INVALID/);
  const info=await good.connector.ruleset('oauth:owner','github-test','owner/repo',42);
  assert.equal(info.name,'master');
  assert.match(good.calls[1].url,/\/rulesets\/42$/);
});

test('classic branch protection validates branch and rejects administrative writes',async()=>{
  const good=fixture({httpResult:{required_status_checks:{contexts:['build']},enforce_admins:{enabled:true}}});
  await assert.rejects(()=>good.connector.classicProtection('oauth:owner','github-test','owner/repo','../master'),/GITHUB_BRANCH_INVALID/);
  const info=await good.connector.classicProtection('oauth:owner','github-test','owner/repo','master');
  assert.equal(info.protected,true);
  assert.deepEqual(info.requiredStatusChecks,{contexts:['build']});
  assert.equal(typeof good.connector.updateRuleset,'undefined');
});
