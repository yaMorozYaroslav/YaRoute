const { test } = require('node:test');
const assert = require('node:assert/strict');
const {authorizeGitPlan} = require('../dist/connectors/git-operations');

const connection = {
 id:'x',ownerId:'alice',displayName:'Development',provider:'github',
 externalAccountId:'me',status:'active',installationId:'10',
 capabilities:['git:inspect','git:push'],
 providerCapabilities:['git:inspect','git:push'],
 resources:[{kind:'repository',id:'example/code',
   capabilities:['git:inspect','git:push'],branches:['master']}],
};
test('read-only Git planning has no executable command',()=>{
 const plan=authorizeGitPlan(connection,'status','example/code','master');
 assert.equal(plan.executable,false);
 assert.equal(plan.executor,'isolated-git-worker');
});
test('remote mutation requires explicit approval',()=>{
 assert.throws(()=>authorizeGitPlan(connection,'push','example/code','master'),/GIT_APPROVAL_REQUIRED/);
 assert.equal(authorizeGitPlan(connection,'push','example/code','master',true).requiresApproval,true);
});
test('Git planning restricts resource and branch',()=>{
 assert.throws(()=>authorizeGitPlan(connection,'status','elsewhere/repo','master'),/GIT_RESOURCE_FORBIDDEN/);
 assert.throws(()=>authorizeGitPlan(connection,'status','example/code','other'),/GIT_RESOURCE_FORBIDDEN/);
 assert.throws(()=>authorizeGitPlan(connection,'status','../code'),/GIT_REPOSITORY_INVALID/);
});
