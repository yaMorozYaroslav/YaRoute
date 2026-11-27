const {test}=require('node:test');
const assert=require('node:assert/strict');
const {
 parseKeyFinUpdCommand,finalizeYaroPlanning,updateYaroPlanning,
 publicFinUpdPreflight,
}=require('../dist/nyx/yaro-key-fin-upd');

const cand=(id,target='head',source='chat:user:c1',confidence=.94,blocked=false)=>({
 id,target,description:'Implement '+id+' with verified source fidelity.',
 source,confidence,blocked,
});
const SHA='a'.repeat(64);
const verified=(scope='global')=>
 ['current_chat','head','body','footer',
  ...(scope==='global'?['active_keys','pending_keys','lcb']:[])]
 .map(sourceClass=>({sourceClass,ref:'verified:source/'+sourceClass,sha256:SHA,verifiedByAdapter:true}));
const disposition=(c,status='queued_for_target_bundle')=>({
 id:c.id,target:c.target,status,reason:'Explicitly user-approved target instruction',
 instructions:['Preserve '+c.id+' in the '+c.target+' update slice'],source:c.source,
});

test('Head v032 explicit KEY→FIN→UPD grammar and pending KEY shorthand expand identically',()=>{
 const spellings=[
  'Nyx key oFxS x fin x upd Go',
  'NyxkeyoFxSxfinxupdGo',
  'Nyx key oF x key oS x fin x upd Go',
  'Nyx key oF x oS x fin x upd Go',
 ];
 for(const raw of spellings){
  const parsed=parseKeyFinUpdCommand(raw);
  assert.deepEqual(parsed.stages,['key_oF','key_oS','fin','upd'],raw);
  assert.equal(parsed.scope,'global',raw);
  assert.equal(parsed.normalized,'NyxkeyoFxkeyoSxfinxupdGo');
 }
 assert.equal(parseKeyFinUpdCommand(spellings[2]).pendingAlias,false);
 assert.equal(parseKeyFinUpdCommand(spellings[0]).pendingAlias,true);
});

test('inherited Go applies to each step; without Go remains local',()=>{
 const a=parseKeyFinUpdCommand('Nyx key oFxS x fin x upd');
 assert.equal(a.scope,'local');
 assert.equal(a.normalized,'NyxkeyoFxkeyoSxfinxupd');
 assert.deepEqual(parseKeyFinUpdCommand('Nyx fin x upd Go').stages,['fin','upd']);
 assert.deepEqual(parseKeyFinUpdCommand('Nyx upd Go').stages,['upd']);
 assert.deepEqual(parseKeyFinUpdCommand('Nyx key oFxS').stages,['key_oF','key_oS']);
 assert.equal(parseKeyFinUpdCommand('Nyx key oFxSG').scope,'global');
 assert.equal(parseKeyFinUpdCommand('Nyx key oFxSL').scope,'local');
 assert.equal(parseKeyFinUpdCommand('Nyx key oFxSG').normalized,'NyxkeyoFxkeyoSGo');
});

test('no general xS meaning, F→S reversal, UPD-before-FIN or scope escalation',()=>{
 const invalid=[
  'Nyx key oF x S x fin x upd Go',
  'Nyx key oF x upd Go',
  'Nyx key oS x key oF x fin x upd Go',
  'Nyx key oFxS x upd Go',
  'Nyx key oFxS x fin x upd oG',
  'Nyx fin x key oF x upd Go',
  'Nyx key oFS x fin x upd Go',
  'Nyx key oFxSG x fin x upd Go',
  'Nyx key oLFxG x fin Go',
  'Nyx key oFxS x fin x gen Go',
  'Nyx key oFxS x fin x upd x can Go',
  'NyxkeyoFxxkeyoSxfinxupdGo',
 ];
 for(const raw of invalid)assert.throws(
  ()=>parseKeyFinUpdCommand(raw),/YARO_COMMAND_/,raw);
});

test('global FIN blocks until *all* required source classes have trusted receipts',()=>{
 const c=cand('H32_modifier');
 const plan=finalizeYaroPlanning({
  scope:'global',executionId:'same_chat_1',candidates:[c],
  sourceReceipts:verified('global').filter(x=>x.sourceClass!=='lcb'),
  dispositions:[disposition(c)],
 });
 assert.equal(plan.status,'PARTIAL_DIAGNOSTIC');
 assert.deepEqual(plan.missingSourceClasses,['lcb']);
 assert.equal(plan.finSeedCandidate,null);
 assert.equal(updateYaroPlanning({fin:plan,executionId:'same_chat_1'}).status,
  'BLOCKED_FIN_PRECONDITION');
 assert.equal(plan.selectedGenerationCore,null);
});

test('Head and Body slices are prepared only with complete verified evidence and dispositions',()=>{
 const a=cand('Head_grammar'),b=cand('Body_domain','body','chat:user:c2');
 const plan=finalizeYaroPlanning({
  scope:'global',executionId:'same_chat_2',
  candidates:[a,b],sourceReceipts:verified(),
  dispositions:[disposition(a),disposition(b)],
 });
 assert.equal(plan.status,'FIN_PASS');
 assert.equal(plan.selectedGenerationCore,null);
 assert.equal(plan.headSlice.length,1);
 assert.equal(plan.bodySlice.length,1);
 assert.equal(plan.footerContinuity.length,0);
 assert.equal(plan.keyUtilization.length,2);
 assert.equal(plan.persisted,false);
 const upd=updateYaroPlanning({fin:plan,executionId:'same_chat_2'});
 assert.equal(upd.status,'UPD_PASS_UNPERSISTED');
 assert.equal(upd.sameChatFinVerified,true);
 assert.equal(upd.headInstructions.length,1);
 assert.equal(upd.bodyInstructions.length,1);
 assert.equal(upd.canonicalChanged,false);
 assert.equal(upd.persisted,false);
 // A FIN in a different chat cannot legally satisfy UPD.
 assert.equal(updateYaroPlanning({fin:plan,executionId:'different_chat'}).status,
  'BLOCKED_FIN_PRECONDITION');
});

test('every in-scope KEY requires an explicit sourced disposition',()=>{
 const a=cand('A'),b=cand('B'),c=cand('C','footer');
 const plan=finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_3',candidates:[a,b,c],
  sourceReceipts:verified('local'),dispositions:[disposition(a)],
 });
 assert.equal(plan.status,'PARTIAL_DIAGNOSTIC');
 assert.deepEqual(plan.missingDispositions,['footer:C','head:B']);
 assert.equal(plan.keyUtilization.length,3);
 assert.ok(plan.keyUtilization.find(x=>x.id==='B').reason);
 assert.equal(plan.finSeedCandidate,null);
});

test('confidence-below-threshold item cannot be silently promoted to implement',()=>{
 const c=cand('Maybe', 'body','chat:user:maybe',.65,true);
 const plan=finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_4',
  candidates:[c],sourceReceipts:verified('local'),
  dispositions:[disposition(c)],
 });
 assert.equal(plan.status,'PARTIAL_DIAGNOSTIC');
 assert.deepEqual(plan.unresolved,['body:Maybe']);
 const blocked=finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_4',
  candidates:[c],sourceReceipts:verified('local'),
  dispositions:[{...disposition(c,'blocked_with_reason'),instructions:[]}],
 });
 assert.equal(blocked.status,'FIN_PASS');
 assert.deepEqual(blocked.bodySlice.map(x=>x.status),['blocked_with_reason']);
});

test('duplicate KEY identities with contradictory sources fail closed',()=>{
 const a=cand('same');const b={...a,source:'chat:user:other'};
 assert.throws(()=>finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_5',
  candidates:[a,b],sourceReceipts:verified('local'),dispositions:[],
 }),/YARO_KEY_PROVENANCE_CONFLICT/);
});

test('invalid / duplicate dispositions fail rather than silently drop inputs',()=>{
 const c=cand('c');
 const valid=disposition(c);
 for(const dispositions of [
  [valid,valid],
  [{...valid,source:'wrong'}],
  [{...valid,status:'invented'}],
  [{...valid,reason:''}],
  [{...valid,instructions:[]}],
 ]) assert.throws(()=>finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_6',
  candidates:[c],sourceReceipts:verified('local'),
  dispositions,
 }),/YARO_DISPOSITION_/);
});

test('unverified caller assertions are not authoritative source readback',()=>{
 const c=cand('x');
 const e=verified('global');
 e[1]={...e[1],verifiedByAdapter:false};
 const result=finalizeYaroPlanning({
  scope:'global',executionId:'same_chat_7',candidates:[c],
  sourceReceipts:e,dispositions:[disposition(c)],
 });
 assert.equal(result.status,'PARTIAL_DIAGNOSTIC');
 assert.deepEqual(result.missingSourceClasses,['head']);
});

test('public preflight cannot invent FIN/UPD or canonical persistence',()=>{
 const p=publicFinUpdPreflight({
  scope:'global',executionId:'same_chat_8',
  candidates:[cand('one'),cand('two','footer')],
  hasExplicitChatMessages:true,
 });
 assert.equal(p.status,'PARTIAL_DIAGNOSTIC');
 assert.equal(p.fin.status,'PARTIAL_DIAGNOSTIC');
 assert.equal(p.upd.status,'BLOCKED_FIN_PRECONDITION');
 assert.equal(p.noCanonicalChanges,true);
 assert.equal(p.fin.keyUtilization.length,2);
 assert.equal(p.fin.selectedGenerationCore,null);
 assert.equal(p.sourceCoverage.canonicalHeadBodyFooter,'not_accessed');
 assert.equal(p.sourceCoverage.explicitMessages,'supplied_not_full_chat');
 assert.equal(p.fin.finSeedCandidate,null);
});

test('empty scope and oversized inventory do not create fake ready FIN',()=>{
 const empty=finalizeYaroPlanning({
  scope:'global',executionId:'same_chat_9',candidates:[],sourceReceipts:[],
 });
 assert.equal(empty.status,'PARTIAL_DIAGNOSTIC');
 assert.equal(empty.missingSourceClasses.length,7);
 const oversized=Array.from({length:2001},(_,n)=>cand('c'+n));
 assert.throws(()=>finalizeYaroPlanning({
  scope:'local',executionId:'same_chat_10',candidates:oversized,
  sourceReceipts:verified('local'),
 }),/YARO_KEY_INVENTORY_INVALID/);
});
