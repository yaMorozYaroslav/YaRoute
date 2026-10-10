const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KeyEngine } = require('../dist/nyx/key-engine');
class MemoryStore {
  constructor() { this.data = new Map([['temp_key.json', JSON.stringify({ candidates: [] })]]); }
  async read(p) { return this.data.get(p) ?? null; }
  async writeNew(p,v) { if(this.data.has(p)) throw Error('KEY_ALREADY_EXISTS'); this.data.set(p,v); }
}
const candidate = { id:'proposal1', target:'head', description:'Update CLI contract', confidence:0.9, source:'conversation' };
test('oF stages a verified temp KEY and no seed', async () => {
 const store = new MemoryStore();
 const result = await new KeyEngine(store).execute({stage:'oF',scope:'local',keyPath:'temp_key.json',seedDirectory:'transactions',candidates:[candidate],transactionId:'t001'});
 assert.equal(result.status,'STAGED');
 assert.equal(result.mutations.length,2);
 assert.equal(store.data.get('temp_key.json'), JSON.stringify({candidates:[]}));
 assert.match(store.data.get('transactions/key_t001.receipt.json'), /beforeSha256/);
});
test('oS generates target-specific proposal with provenance', async () => {
 const store = new MemoryStore();
 const result = await new KeyEngine(store).execute({stage:'oS',scope:'global',keyPath:'temp_key.json',seedDirectory:'transactions',candidates:[candidate],transactionId:'t002'});
 assert.equal(result.mutations.length,3);
 const seed=JSON.parse(store.data.get('transactions/key_t002.head.seed.json'));
 assert.equal(seed.target,'head');
 assert.equal(seed.status,'pending_validation');
 assert.equal(seed.candidates[0].source,'conversation');
});
test('repeat transaction cannot overwrite immutable artifacts', async () => {
 const store = new MemoryStore(); const engine=new KeyEngine(store);
 const req={stage:'oF',scope:'local',keyPath:'temp_key.json',seedDirectory:'transactions',candidates:[candidate],transactionId:'t003'};
 await engine.execute(req);
 await assert.rejects(()=>engine.execute(req),/KEY_ALREADY_EXISTS/);
});
test('missing temp KEY fails closed', async () => {
 await assert.rejects(()=>new KeyEngine(new MemoryStore()).execute({stage:'oF',scope:'local',keyPath:'absent',seedDirectory:'transactions',candidates:[],transactionId:'t004'}),/KEY_SOURCE_MISSING/);
});
