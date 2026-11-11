const {test}=require('node:test');
const assert=require('node:assert/strict');
const {extractKeySignals}=require('../dist/nyx/key-chat-extractor');
const {KeyEngine}=require('../dist/nyx/key-engine');

class Store {
  constructor(){this.data=new Map([['temp_key.json',JSON.stringify({candidates:[]})]]);}
  async read(path){return this.data.get(path)??null;}
  async writeNew(path,content){if(this.data.has(path))throw Error('KEY_ALREADY_EXISTS');this.data.set(path,content);}
}
const messages=[
  {role:'user',id:'one',text:'Please implement KEY oF and oS in NestNyx Dev. Deploy to Dev and test the implementation.'},
  {role:'assistant',id:'two',text:'I deployed production and verified everything.'},
  {role:'user',id:'three',text:'Fix the stale bootstrap and preserve the current Head core.'},
];
test('extracts user instructions only, including traceable evidence',()=>{
  const result=extractKeySignals(messages);
  assert.equal(result.schema,'nyx.key.chat-extraction.v1');
  assert.equal(result.status,'PROPOSAL_ONLY');
  assert.equal(result.suppliedMessageCount,3);
  assert.ok(result.candidates.length>=2);
  assert.ok(result.candidates.every(x=>x.source.startsWith('chat:user:')));
  assert.ok(result.candidates.every(x=>x.confidence>=0 && x.confidence<=1));
  assert.ok(result.candidates.every(x=>!x.description.includes('I deployed production')));
  assert.ok(result.candidates.every(x=>/^[a-zA-Z0-9_-]+$/.test(x.id)));
});
test('deduplicates exact user instructions and stays deterministic',()=>{
 const result=extractKeySignals([messages[0],messages[0]]);
 assert.deepEqual(result.candidates.map(x=>x.id),extractKeySignals([messages[0]]).candidates.map(x=>x.id));
 assert.ok(result.ignored>0);
});
test('refuses credentials; never returns raw secret text',()=>{
 assert.throws(()=>extractKeySignals([{role:'user',text:'Deploy password: hunter2_forbidden'}]),/KEY_CHAT_UNSAFE_INPUT/);
 assert.throws(()=>extractKeySignals([{role:'user',text:'Fix access_token=very_secret_credential'}]),/KEY_CHAT_UNSAFE_INPUT/);
});
test('bounded input and speculative questions cannot become KEY automatically',()=>{
 assert.throws(()=>extractKeySignals([]),/KEY_CHAT_INPUT_BOUNDS/);
 assert.throws(()=>extractKeySignals([{role:'user',text:'x'.repeat(6001)}]),/KEY_CHAT_INPUT_INVALID/);
 assert.equal(extractKeySignals([{role:'user',text:'What if we deploy this automatically?'}]).candidates.length,0);
});
test('oF stages only temp key and receipt; oS stages target seed proposal',async()=>{
 const extracted=extractKeySignals(messages);
 const candidates=extracted.candidates.map(({evidence,...x})=>x);
 const first=new Store();
 const file=await new KeyEngine(first).execute({stage:'oF',scope:'global',keyPath:'temp_key.json',
   seedDirectory:'transactions',candidates,transactionId:'chatcase1'});
 assert.equal(file.status,'STAGED');
 assert.equal([...first.data.keys()].filter(x=>x.endsWith('.seed.json')).length,0);
 assert.equal(file.mutations.length,2);
 const second=new Store();
 const seed=await new KeyEngine(second).execute({stage:'oS',scope:'global',keyPath:'temp_key.json',
   seedDirectory:'transactions',candidates,transactionId:'chatcase2'});
 assert.equal(seed.status,'STAGED');
 assert.ok([...second.data.keys()].some(x=>x.endsWith('.head.seed.json')));
 assert.ok([...second.data.values()].some(x=>typeof x==='string' && x.includes('pending_validation')));
 assert.equal(second.data.get('temp_key.json'),JSON.stringify({candidates:[]}));
});
