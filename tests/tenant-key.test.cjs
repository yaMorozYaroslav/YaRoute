const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NyxTenantKeyService}=require('../dist/nyx/tenant-key.service');
const rows=new Map();
const key=(a,b)=>a+'::'+b;
const fakePool={async query(sql,params){
  if(sql.includes('CREATE TABLE'))return {rows:[],rowCount:0};
  if(sql.includes('INSERT INTO')){
    const [tenant,path,content]=params,k=key(tenant,path);
    if(rows.has(k))return {rows:[],rowCount:0};
    rows.set(k,content);return {rows:[{artifact_path:path}],rowCount:1};
  }
  if(sql.includes('SELECT content')){
    const [tenant,path]=params,c=rows.get(key(tenant,path));
    return {rows:c===undefined?[]:[{content:c}],rowCount:c===undefined?0:1};
  }
  if(sql.includes('UPDATE nyx_tenant_key_artifacts_v1')){
    const [next,tenant,path,old]=params,k=key(tenant,path);
    if(rows.get(k)!==old)return {rows:[],rowCount:0};
    rows.set(k,next);return {rows:[{artifact_path:path}],rowCount:1};
  }
  throw Error('UNEXPECTED_SQL');
}};
function service(){
 const s=new NyxTenantKeyService();
 s.pool=fakePool;
 s.init=Promise.resolve();
 return s;
}
const candidate=(description)=>({id:'change_'+description.replace(/[^a-z]/gi,'').slice(0,40),target:'head',
 description,confidence:0.92,source:'chat:user:1'});
const run=(s,owner,stage,transactionId,description)=>s.execute(owner,{
 stage,scope:'global',transactionId,candidates:[candidate(description)]});
test('oF applies tenant key through atomic CAS without seed; other tenants cannot read it',async()=>{
 const saved={flag:process.env.NYX_KEY_TENANT_ENABLED,url:process.env.DATABASE_URL};
 try{
  process.env.NYX_KEY_TENANT_ENABLED='true';process.env.DATABASE_URL='postgres://mock/key';
  const s=service(),a=await run(s,'oauth:user-one','oF','txn_1','Implement secure key handling');
  assert.equal(a.status,'APPLIED');assert.equal(a.activeUpdated,true);assert.equal(a.tenantIsolated,true);
  assert.ok([...rows.keys()].some(k=>k.endsWith('transactions/key_txn_1.receipt.json')));
  assert.equal([...rows.keys()].filter(k=>k.endsWith('.seed.json')).length,0);
  const b=await run(s,'oauth:user-two','oF','txn_2','Deploy a separate item');
  assert.equal(b.status,'APPLIED');
  const principals=[...rows.keys()].filter(x=>x.endsWith('::temp_key.json'));
  assert.equal(principals.length,2);
  assert.notEqual(rows.get(principals[0]),rows.get(principals[1]));
 }finally{
  if(saved.flag===undefined)delete process.env.NYX_KEY_TENANT_ENABLED;else process.env.NYX_KEY_TENANT_ENABLED=saved.flag;
  if(saved.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=saved.url;
 }
});
test('oS creates a pending-validation seed, not a canonical core or unreviewed promotion',async()=>{
 const saved={flag:process.env.NYX_KEY_TENANT_ENABLED,url:process.env.DATABASE_URL};
 try{
  process.env.NYX_KEY_TENANT_ENABLED='true';process.env.DATABASE_URL='postgres://mock/key';
  const s=service(),r=await run(s,'oauth:user-three','oS','txn_3','Update Head CLI contracts');
  assert.equal(r.status,'APPLIED');assert.equal(r.canonicalChanged,false);
  const seed=[...rows.entries()].filter(([k])=>k.endsWith('transactions/key_txn_3.head.seed.json'));
  assert.equal(seed.length,1);
  assert.equal(JSON.parse(seed[0][1]).status,'pending_validation');
 }finally{
  if(saved.flag===undefined)delete process.env.NYX_KEY_TENANT_ENABLED;else process.env.NYX_KEY_TENANT_ENABLED=saved.flag;
  if(saved.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=saved.url;
 }
});
test('public KEY staging is disabled without flag and rejects unauthenticated owners',async()=>{
 const saved=process.env.NYX_KEY_TENANT_ENABLED;
 try{
  delete process.env.NYX_KEY_TENANT_ENABLED;
  await assert.rejects(()=>run(service(),'oauth:user-four','oF','txn_4','Implement feature'),/KEY_TENANT_STAGE_NOT_ENABLED/);
  process.env.NYX_KEY_TENANT_ENABLED='true';
  await assert.rejects(()=>run(service(),'untrusted','oF','txn_5','Implement feature'),/KEY_OWNER_NOT_VERIFIED/);
 }finally{
  if(saved===undefined)delete process.env.NYX_KEY_TENANT_ENABLED;else process.env.NYX_KEY_TENANT_ENABLED=saved;
 }
});
