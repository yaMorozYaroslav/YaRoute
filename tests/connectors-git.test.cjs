const {test}=require('node:test');
const assert=require('node:assert/strict');
const {authorizeGitPlan}=require('../dist/connectors/git-operations');
const historical={
 id:'old',ownerId:'alice',displayName:'Git',provider:'github',
 externalAccountId:'me',status:'active',installationId:'10',
 capabilities:['git:inspect','git:push'],
 providerCapabilities:['git:inspect','git:push'],
 resources:[{kind:'repository',id:'example/code',capabilities:['git:inspect','git:push']}],
};
test('historical Git CLI helper is permanently disabled regardless of grants',()=>{
 for(const operation of ['status','clone','push','commit','branch.create']){
   assert.throws(()=>authorizeGitPlan(historical,operation,'example/code','master',true),
    /NYX_GIT_CLI_DISABLED_USE_PROVIDER_API/);
 }
});
