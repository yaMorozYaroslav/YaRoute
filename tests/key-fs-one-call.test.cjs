const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseKeyFsCommand,keyFsFingerprint,keyFsTransactionId}=require('../dist/nyx/key-fs.command');
const {NyxTenantKeyService}=require('../dist/nyx/tenant-key.service');

function candidate(description,overrides={}){
 return {id:'proposal_'+description.toLowerCase().replace(/[^a-z]+/g,'_').slice(0,30),
 target:'head',description,confidence:0.93,source:'chat:user:1',...overrides};
}
function makeDb(){
 const rows=new Map();
 let failSeed=false,commits=0,rollbacks=0;
 const key=(tenant,path)=>tenant+'::'+path;
 const sql=(data,q,args=[])=>{
   if(q.includes('CREATE TABLE'))return {rowCount:0,rows:[]};
   if(q.includes('INSERT INTO nyx_tenant_key_artifacts_v1')){
     const [tenant,path,content]=args;
     if(failSeed&&path.endsWith('.seed.json'))throw Error('MOCK_SEED_WRITE_FAIL');
     const k=key(tenant,path);
     if(data.has(k))return {rowCount:0,rows:[]};
     data.set(k,content);return {rowCount:1,rows:[{artifact_path:path}]};
   }
   if(q.includes('SELECT content FROM nyx_tenant_key_artifacts_v1')){
     const [tenant,path]=args,k=key(tenant,path);
     const v=data.get(k);
     return v===undefined?{rowCount:0,rows:[]}:{rowCount:1,rows:[{content:v}]};
   }
   if(q.includes('UPDATE nyx_tenant_key_artifacts_v1')){
     const [next,tenant,path,old]=args,k=key(tenant,path);
     if(data.get(k)!==old)return {rowCount:0,rows:[]};
     data.set(k,next);return {rowCount:1,rows:[{artifact_path:path}]};
   }
   throw Error('UNEXPECTED_SQL:'+q);
 };
 const pool={
   query:async(q,args)=>sql(rows,q,args),
   connect:async()=>{
     let local,started=false;
     return {
       async query(q,args){
         if(q==='BEGIN'){local=new Map(rows);started=true;return {rowCount:0,rows:[]};}
         if(q==='COMMIT'){
           assert.ok(started);
           rows.clear();for(const [k,v] of local)rows.set(k,v);
           commits++;started=false;return {rowCount:0,rows:[]};
         }
         if(q==='ROLLBACK'){started=false;rollbacks++;return {rowCount:0,rows:[]};}
         assert.ok(started);return sql(local,q,args);
       },release(){},
     };
   },
 };
 return {rows,pool,failSeeds(v){failSeed=v;},get commits(){return commits;},get rollbacks(){return rollbacks;}};
}
function service(db){
 const s=new NyxTenantKeyService();
 s.pool=db.pool;
 s.init=Promise.resolve();
 return s;
}
async function run(input,fn){
 const old={flag:process.env.NYX_KEY_TENANT_ENABLED,url:process.env.DATABASE_URL};
 try {
   delete process.env.NYX_KEY_TENANT_ENABLED;
   process.env.DATABASE_URL='postgres://mock/key_fs';
   return await fn();
 }finally{
   if(old.flag===undefined)delete process.env.NYX_KEY_TENANT_ENABLED;
   else process.env.NYX_KEY_TENANT_ENABLED=old.flag;
   if(old.url===undefined)delete process.env.DATABASE_URL;
   else process.env.DATABASE_URL=old.url;
 }
}
const keyInput={command:'Nyx key oF x oS Go',
 candidates:[candidate('Implement strict KEY parser')]};
test('strict KEY-specific grammar: oFxS and oF x oS normalize to F then S',()=>{
 for(const input of ['Nyx key oFxS Go','Nyx key oF x oS Go',
   'Nyx key oF x key oS Go','NyxkeyoFxSGo','NyxkeyoFxkeyoSGo',
   'NyxkeyoFxSG','Nyx key oFxSG']){
   assert.deepEqual(parseKeyFsCommand(input).scope,'global');
   assert.equal(parseKeyFsCommand(input).expanded,'NyxkeyoFxkeyoSGo');
 }
 assert.equal(parseKeyFsCommand('Nyx key oF x oS').scope,'local');
 for(const input of ['Nyx key oFxS', 'NyxkeyoFxSL', 'Nyx key oFxSL']){
   const parsed=parseKeyFsCommand(input);
   assert.equal(parsed.scope,'local');
   assert.equal(parsed.expanded,'NyxkeyoFxkeyoS');
   assert.equal(parsed.aliasPendingHead,true);
 }
 assert.equal(parseKeyFsCommand('Nyx key oFxSG').expanded,'NyxkeyoFxkeyoSGo');
 assert.equal(parseKeyFsCommand('Nyx key oFxSG').aliasPendingHead,true);
 assert.equal(parseKeyFsCommand('Nyx key oF x key oS Go').aliasPendingHead,false);
 for(const input of ['Nyx key oS x oF Go','Nyx key oF x fin Go',
   'Nyx key oF x oS x upd Go','Nyx gen oFxS Go','Nyx key oFS Go',
   'Nyx key x S Go','Nyx key oFxS xoS','NyxkeyoFxxoSGo',
   'Nyx key oLFxG','Nyx key oSxFL','Nyx key oFxSGL',
   'Nyx key oF x key oS G','Nyx key oF x oS L']){
   assert.throws(()=>parseKeyFsCommand(input),/KEY_FS_COMMAND_INVALID/,input);
 }
});
test('new local/global aliases keep separate deterministic tenant transaction scopes',()=>run(null,async()=>{
 const db=makeDb(),svc=service(db);
 const glob=await svc.executeFs('oauth:scope-user',{...keyInput,command:'Nyx key oFxSG'});
 const loc=await svc.executeFs('oauth:scope-user',{...keyInput,command:'Nyx key oFxSL'});
 assert.equal(glob.scope,'global');
 assert.equal(loc.scope,'local');
 assert.notEqual(glob.transactionId,loc.transactionId);
 assert.equal(glob.status,'APPLIED');
 assert.equal(loc.status,'APPLIED');
 assert.equal([...db.rows].filter(([k])=>k.endsWith('.fs.done.json')).length,2);
 assert.equal(db.commits,2);
}));

test('same evidence yields same transaction; malformed ID fails closed',()=>{
 const a=keyFsFingerprint('global',keyInput.candidates);
 assert.equal(a,keyFsFingerprint('global',[...keyInput.candidates]));
 assert.equal(keyFsTransactionId(a),keyFsTransactionId(a));
 assert.throws(()=>keyFsTransactionId(a,'../danger'),/KEY_FS_TRANSACTION_ID_INVALID/);
});
test('one invocation applies F before S with a verified pending seed and one COMMIT',()=>run(null,async()=>{
 const db=makeDb();
 const r=await service(db).executeFs('oauth:owner-one',keyInput);
 assert.equal(r.status,'APPLIED');assert.equal(r.scope,'global');
 assert.equal(r.replayed,false);assert.equal(db.commits,1);
 assert.deepEqual(r.stages,['oF','oS']);
 assert.equal(r.canonicalChanged,false);assert.equal(r.seedStatus,'pending_validation');
 const find=(suffix)=>[...db.rows].find(([k])=>k.endsWith(suffix))?.[1];
 const f=JSON.parse(find('_F.receipt.json'));
 const s=JSON.parse(find('_S.receipt.json'));
 const done=JSON.parse(find('.fs.done.json'));
 assert.equal(f.stage,'oF');assert.equal(s.stage,'oS');
 assert.equal(f.afterSha256,s.beforeSha256);
 assert.equal(s.afterSha256,done.afterSha256);
 assert.ok(JSON.parse(find('_S.head.seed.json')).candidates.some(x=>
   x.description==='Implement strict KEY parser'));
 assert.equal(JSON.parse(find('_S.head.seed.json')).status,'pending_validation');
 assert.ok(find('::temp_key.json').includes('Implement strict KEY parser'));
 assert.equal(db.rollbacks,0);
}));
test('same request is replayed without another write or duplicate seed',()=>run(null,async()=>{
 const db=makeDb(),s=service(db);
 const first=await s.executeFs('oauth:replay',keyInput);
 const count=db.rows.size;
 const second=await s.executeFs('oauth:replay',keyInput);
 assert.equal(second.status,'APPLIED');assert.equal(second.replayed,true);
 assert.equal(first.transactionId,second.transactionId);
 assert.equal(db.commits,2);assert.equal(db.rows.size,count);
 const marker=[...db.rows].filter(([k])=>k.endsWith('.fs.done.json'));
 assert.equal(marker.length,1);
}));
test('seed stage failure rolls back F as well: no partial active KEY',()=>run(null,async()=>{
 const db=makeDb();db.failSeeds(true);
 await assert.rejects(()=>service(db).executeFs('oauth:failing',keyInput),/MOCK_SEED_WRITE_FAIL/);
 assert.equal(db.rollbacks,1);assert.equal(db.commits,0);assert.equal(db.rows.size,0);
}));
test('blocked-only candidate cannot claim a generated seed',()=>run(null,async()=>{
 const db=makeDb();
 await assert.rejects(()=>service(db).executeFs('oauth:blocked',{
 command:'Nyx key oFxS',candidates:[candidate('We should maybe check later',{blocked:true,confidence:0.66})],
 }),/KEY_FS_SEED_PROPOSAL_EMPTY/);
 assert.equal(db.rows.size,0);
}));
test('bad command and unauthenticated owner cannot write',()=>run(null,async()=>{
 const db=makeDb(),s=service(db);
 await assert.rejects(()=>s.executeFs('oauth:a',{...keyInput,command:'Nyx gen oFxS Go'}),/KEY_FS_COMMAND_INVALID/);
 await assert.rejects(()=>s.executeFs('untrusted',keyInput),/KEY_OWNER_NOT_VERIFIED/);
 assert.equal(db.rows.size,0);
}));
test('tenant separation and replay conflict are enforced',()=>run(null,async()=>{
 const db=makeDb(),s=service(db);
 const a=await s.executeFs('oauth:tenant-a',{...keyInput,transactionId:'same'});
 const b=await s.executeFs('oauth:tenant-b',{...keyInput,transactionId:'same'});
 assert.equal(a.status,'APPLIED');assert.equal(b.status,'APPLIED');
 assert.equal([...db.rows].filter(([k])=>k.endsWith('.fs.done.json')).length,2);
 await assert.rejects(()=>s.executeFs('oauth:tenant-a',{
 ...keyInput,transactionId:'same',candidates:[candidate('Deploy unrelated operation')],
 }),/KEY_FS_REPLAY_CONFLICT/);
}));

test('readback-verified KEY inventory includes only authenticated owner and all active candidates',()=>run(null,async()=>{
 const db=makeDb(),s=service(db);
 await s.executeFs('oauth:owner-a',{command:'Nyx key oFxSG',
  candidates:[candidate('Owned by A')]});
 await s.executeFs('oauth:owner-b',{command:'Nyx key oFxSG',
  candidates:[candidate('Owned by B')]});
 const a=await s.inspectPlanningSource('oauth:owner-a');
 const b=await s.inspectPlanningSource('oauth:owner-b');
 assert.equal(a.readbackVerified,true);
 assert.equal(a.scope,'owner-isolated');
 assert.match(a.sha256,/^[a-f0-9]{64}$/);
 assert.ok(a.candidates.some(x=>x.description==='Owned by A'));
 assert.ok(!a.candidates.some(x=>x.description==='Owned by B'));
 assert.ok(b.candidates.some(x=>x.description==='Owned by B'));
 assert.ok(!b.candidates.some(x=>x.description==='Owned by A'));
 await assert.rejects(()=>s.inspectPlanningSource('unverified'),/KEY_OWNER_NOT_VERIFIED/);
}));
