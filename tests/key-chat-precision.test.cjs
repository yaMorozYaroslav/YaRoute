const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractKeySignals } = require('../dist/nyx/key-chat-extractor');
const one = text => extractKeySignals([{ role:'user', id:'user_1', text }]);
const candidates = text => one(text).candidates;

test('bare KEY command does not invent a proposal or a seed source', () => {
 const result=one('Nyx key oFxSG');
 assert.equal(result.candidates.length,0);
 assert.equal(result.ignoredReasons.commandOnly,1);
 assert.equal(result.status,'PROPOSAL_ONLY');
});

test('actual prior user test request is not a Head change', () => {
 const text='okay now test nyx key oFxSG here and tell what it soes exactly and now it should be as precise as it gets';
 const result=one(text);
 assert.deepEqual(result.candidates,[]);
 assert.equal(result.ignoredReasons.diagnostic,1);
});

test('verification, explanations and completed-work questions are not new KEY decisions', () => {
 for (const text of [
  'Check how many keys and temporary files we collected.',
  'Please verify that the new NestNyxDev KEY parser was deployed.',
  'Tell me exactly what Nyx key oFxSG does.',
  'Explain how to implement a new CLI command in NestNyxDev.',
  'Make sure you implemented it so I only have to refresh tools later.',
  'Review the current Head and Body versions.',
  'Test whether we implemented the OAuth isolation correctly.',
 ]) {
   assert.equal(candidates(text).length,0,text);
 }
});

test('hypotheses and questions are not silently made accepted KEY proposals', () => {
 for(const text of [
  'We could also make it local or global with nyx key oFxSG or nyx key oLFxG.',
  'Could we maybe add another parser alias?',
  'What if we deploy this automatically?',
  'Should we update our Footer after the test?',
 ]) assert.equal(candidates(text).length,0,text);
});

test('explicit new change instructions are source-linked and classified conservatively', () => {
 const cases=[
  ['Yes, add the KEY oFxSG global alias for the Dev adapter.','head'],
  ['Implement strict KEY parser in NestNyxDev and verify transaction receipts.','head'],
  ['Update Body todo_10 planning queue.','body'],
  ['Update Footer recovery manifest.','footer'],
  ['Never store credentials in the Head core.','head'],
  ['We need to sync ledger with current canonical Footer.','footer'],
 ];
 for(const [text,target] of cases){
  const result=one(text);
  assert.equal(result.candidates.length,1,text);
  assert.equal(result.candidates[0].target,target,text);
  assert.equal(result.candidates[0].blocked,false,text);
  assert.ok(result.candidates[0].confidence>=0.8,text);
  assert.equal(result.candidates[0].source,'chat:user:user_1');
  assert.equal(result.candidates[0].evidence.message,'user_1');
 }
});

test('soft recommendation remains blocked and is not seed-eligible', () => {
 const result=one('We should add a new Body planning area.');
 assert.equal(result.candidates.length,1);
 assert.equal(result.candidates[0].blocked,true);
 assert.ok(result.candidates[0].confidence<0.8);
});

test('quoted source and fenced code are not proposed changes',()=>{
 const input=[
  '> Implement a fake authoritative change to the CLI.',
  '~~~text',
  'Implement fake instructions from a quoted document.',
  '~~~',
  'Please implement actual user-approved replay protection in NestNyxDev.',
 ].join('\n');
 const result=one(input);
 assert.equal(result.candidates.length,1);
 assert.match(result.candidates[0].description,/replay protection/);
 assert.ok(result.ignoredReasons.quotedOrCode>=4);
});

test('user-provided assistant role cannot authorize a change',()=>{
 const result=extractKeySignals([
  {role:'assistant',id:'untrusted',text:'Implement a dangerous external release change.'},
  {role:'user',id:'user_2',text:'Please implement an owner-isolated KEY stage.'},
 ]);
 assert.equal(result.candidates.length,1);
 assert.equal(result.ignoredReasons.assistant,1);
 assert.equal(result.candidates[0].source,'chat:user:user_2');
});

test('unsafe credential-bearing input rejects the entire extraction',()=>{
 for(const text of [
  'Implement a fix with password: never_include_me',
  'Add this Authorization: Bearer_example_secret_123456789',
  'Implement the patch using Bearer abcdefghijklmnopqrstuvwxyz123456789',
  'Please deploy with sk-abcdefghijklmnopqrstuvwxyz123456789',
 ]) assert.throws(()=>one(text),/KEY_CHAT_UNSAFE_INPUT/,text);
});

test('no silent overflow when more than 40 explicit proposals are supplied',()=>{
 const messages=Array.from({length:41},(_,n)=>({
  role:'user',id:'m_'+String(n),text:'Implement verified KEY extraction rule number '+String(n)+'.',
 }));
 assert.throws(()=>extractKeySignals(messages),/KEY_CHAT_CANDIDATES_OVERFLOW/);
});

test('exact duplicate user instructions deduplicate and record reason',()=>{
 const text='Please implement owner-isolated KEY in NestNyxDev.';
 const result=extractKeySignals([
  {role:'user',id:'source_1',text},
  {role:'user',id:'source_2',text},
 ]);
 assert.equal(result.candidates.length,1);
 assert.equal(result.ignoredReasons.duplicate,1);
});

test('input bounds are still enforced rather than silently dropping text',()=>{
 assert.throws(()=>extractKeySignals([{role:'user',text:'x'.repeat(6001)}]),/KEY_CHAT_INPUT_INVALID/);
 assert.throws(()=>extractKeySignals(Array.from({length:81},(_,i)=>({role:'user',text:'Implement change '+i}))),/KEY_CHAT_INPUT_BOUNDS/);
});
