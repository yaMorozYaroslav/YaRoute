const {test}=require('node:test');
const assert=require('node:assert/strict');
const HEAD='a'.repeat(40),BASE='b'.repeat(40),MASTER='c'.repeat(40),SRC='d'.repeat(40);
let mod;
test('load automatic Tester merger without calling GitHub',async()=>{
 mod=await import('../scripts/nyx-tester-auto-merge.mjs');
 assert.equal(typeof mod.validatePull,'function');
 assert.equal(typeof mod.validateChecks,'function');
});
function candidate(){
 const target='yaMorozYaroslav/YaRoute';
 const branch={name:'tester',protected:false,commit:{sha:BASE}},master={name:'master',protected:true,commit:{sha:MASTER}};
 const pr={state:'open',draft:true,mergeable:true,base:{ref:'tester',sha:BASE,repo:{full_name:target}},
  head:{ref:'nyx/promote-'+SRC.slice(0,10)+'-'+BASE.slice(0,10),sha:HEAD,repo:{full_name:target}},
  changed_files:2,requested_reviewers:[],requested_teams:[]};
 return {pr,branch,master,sourceSha:SRC,files:[{filename:'src/tenant.ts',status:'added'},
  {filename:'tests/tenant.test.cjs',status:'modified'}],commit:{sha:HEAD,parents:[{sha:BASE}]}};
}
function checks(){
 return {total_count:2,check_runs:[
  {name:'GitGuardian Security Checks',status:'completed',conclusion:'success'},
  {name:'build',status:'completed',conclusion:'success'}
 ]};
}
test('accept exact-sha safe tester candidate and passing security CI',()=>{
 assert.equal(mod.validatePull(candidate()),true);
 assert.equal(mod.validateChecks(checks()),true);
});
test('refuse master/main or any different target, even if tests passed',()=>{
 const c=candidate();
 assert.throws(()=>mod.validatePull({...c,pr:{...c.pr,base:{...c.pr.base,ref:'master'}}}),/TARGET_CHANGED/);
 assert.throws(()=>mod.validatePull({...c,branch:{...c.branch,protected:true}}),/PROTECTION_CHANGED/);
 assert.throws(()=>mod.validatePull({...c,master:{...c.master,protected:false}}),/PROTECTION_CHANGED/);
 assert.throws(()=>mod.validatePull({...c,pr:{...c.pr,base:{...c.pr.base,sha:MASTER}}}),/TARGET_CHANGED/);
});
test('reject stale branch head, non-Taster ancestry and non-generated PR',()=>{
 const c=candidate();
 assert.throws(()=>mod.validatePull({...c,commit:{...c.commit,parents:[{sha:MASTER}]}}),/PARENT_UNVERIFIED/);
 assert.throws(()=>mod.validatePull({...c,pr:{...c.pr,head:{...c.pr.head,ref:'feature/unsafe'}}}),/SOURCE_UNVERIFIED/);
 assert.throws(()=>mod.validatePull({...c,pr:{...c.pr,requested_reviewers:[{login:'owner'}]}}),/REVIEW_PENDING/);
});
test('never auto-merge edits to hosting, workflow, keys, or default branches',()=>{
 for(const path of ['app.json','.github/workflows/release.yml','scripts/install-rclone.mjs','config/nyx-runtime-profile.json','../outside','src/../../bad']){
  const c=candidate();c.files[0].filename=path;
  assert.throws(()=>mod.validatePull(c),/UNSAFE_PATH/);
 }
});
test('require all exact-sha check runs to be green',()=>{
 const c=checks();
 for(const [name,change] of [
  ['pending',{status:'queued',conclusion:null}],
  ['failure',{status:'completed',conclusion:'failure'}],
  ['skipped',{status:'completed',conclusion:'skipped'}]
 ])assert.throws(()=>mod.validateChecks({...c,check_runs:[c.check_runs[0],{...c.check_runs[1],...change}]}),/CHECK_NOT_GREEN/,name);
 assert.throws(()=>mod.validateChecks({...c,check_runs:[c.check_runs[0]],total_count:1}),/CHECK_INVENTORY_INCOMPLETE/);
 assert.throws(()=>mod.validateChecks({...c,check_runs:[c.check_runs[0],{...c.check_runs[0]}]}),/DUPLICATE_OR_UNNAMED_CHECK/);
});
