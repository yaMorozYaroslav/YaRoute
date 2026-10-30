const {test}=require('node:test');
const assert=require('node:assert/strict');
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),d='d'.repeat(40);
let mod;
test('bot release module is inert when imported',async()=>{
 mod=await import('../scripts/nyx-bot-master-release.mjs');
 assert.equal(mod.releaseBranch(a),'nyx/release-tester-aaaaaaaaaaaa');
});
const checks=()=>({total_count:2,check_runs:[
 {name:'build',status:'completed',conclusion:'success'},
 {name:'GitGuardian Security Checks',status:'completed',conclusion:'success'}]});
function candidate(){
 return {repo:{full_name:'yaMorozYaroslav/YaRoute',default_branch:'master'},
 tester:{name:'tester',protected:false,commit:{sha:a}},
 master:{name:'master',protected:true,commit:{sha:b}},
 commit:{sha:a,tree:{sha:c}},
 compare:{status:'ahead',ahead_by:2,behind_by:0},
 sha:a,pulls:[],checks:checks()};
}
test('only matching Tester, protected master, and green checks yield release intent',()=>{
 assert.deepEqual(mod.validateCandidate(candidate()),
  {sha:a,tree:c,base:b,branch:'nyx/release-tester-aaaaaaaaaaaa'});
});
test('refuse mismatched source SHA, unsafe history, and weakened branch protection',()=>{
 for(const edit of [
  x=>x.sha=d,x=>x.tester.commit.sha=d,x=>x.master.protected=false,
  x=>x.tester.protected=true,x=>x.repo.default_branch='main',
  x=>x.repo.full_name='unexpected/repo',x=>x.commit.tree.sha='invalid',
  x=>x.compare.behind_by=1,x=>x.compare.ahead_by=0,
  x=>x.compare.status='diverged'
 ]){const model=candidate();edit(model);assert.throws(()=>mod.validateCandidate(model),
   /NYX_MASTER_RELEASE_/);}
});
test('existing tester-to-master PR or bot release PR must be reconciled',()=>{
 for(const head of ['tester','nyx/release-tester-aaaaaaaaaaaa']){
  const model=candidate();model.pulls=[{base:{ref:'master'},head:{ref:head}}];
  assert.throws(()=>mod.validateCandidate(model),/EXISTING_RELEASE_PR_REQUIRES_REVIEW/);
 }
});
test('only complete, successful security and build checks are accepted',()=>{
 for(const edit of [
  x=>x.total_count=1,
  x=>x.check_runs[1].name='build',
  x=>x.check_runs[0].conclusion='failure',
  x=>x.check_runs[1].status='pending',
  x=>x.check_runs[1].name='unknown'
 ]){const x=checks();edit(x);
  assert.throws(()=>mod.validateChecks(x),/NYX_MASTER_RELEASE_/);
 }
});
test('bot identity, draft, head and master SHA required at PR readback',()=>{
 const expected={base:b,branch:'nyx/release-tester-aaaaaaaaaaaa',commit:d};
 const p={state:'open',draft:true,base:{ref:'master',sha:b},
 head:{ref:expected.branch,sha:d,repo:{full_name:'yaMorozYaroslav/YaRoute'}},
 user:{login:'nestnyx[bot]'}};
 assert.equal(mod.validateDraft(p,expected),true);
 for(const edit of [x=>x.draft=false,x=>x.user.login='yaMorozYaroslav',
  x=>x.base.ref='tester',x=>x.base.sha=c,
  x=>x.head.ref='tester',x=>x.head.sha=c,
  x=>x.head.repo.full_name='somewhere/else']){
  const x=structuredClone(p);edit(x);
  assert.throws(()=>mod.validateDraft(x,expected),/BOT_DRAFT_READBACK_INVALID/);
 }
});
