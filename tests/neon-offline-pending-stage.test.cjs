const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

const importer=()=>import(pathToFileURL(path.resolve(
  'scripts/nyx-neon-owner-rclone-import.mjs')).href);

const settings=()=>({
  NYX_DEPLOYMENT_MODE:'public',
  NYX_PUBLIC_CONNECTORS_ENABLED:'true',
  NYX_MULTIUSER_RCLONE_ENABLED:'true',
  NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true',
  DATABASE_URL:'postgresql://db.example.invalid/neondb',
  NYX_STORAGE_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
});

test('offline pending-only import can be staged while legacy Heroku settings exist',async()=>{
  const {validateImporterEnvironment}=await importer();
  const legacy={...settings(),RCLONE_CONFIG_B64:'opaque-secret-not-to-emit'};
  for(const mode of ['stage','stage-six']){
    const result=validateImporterEnvironment(legacy,mode);
    assert.equal(result.url,settings().DATABASE_URL);
    assert.equal(result.key.length,32);
    result.key.fill(0);
  }
});

test('activation remains blocked until private operator settings are removed',async()=>{
  const {validateImporterEnvironment}=await importer();
  for(const name of ['RCLONE_CONFIG_B64','RCLONE_CONFIG','RCLONE_CONFIG_PATH',
    'NYX_SHARED_ROOTS_JSON']){
    for(const mode of ['finalize','finalize-six']){
      assert.throws(
        ()=>validateImporterEnvironment({...settings(),[name]:'operator-only'},mode),
        /PUBLIC_ISOLATION_NOT_READY/);
    }
  }
});

test('pending-only mode still needs verified public mode and a real encryption key',async()=>{
  const {validateImporterEnvironment}=await importer();
  for(const prop of ['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
    'NYX_MULTIUSER_RCLONE_ENABLED','NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED']){
    assert.throws(()=>validateImporterEnvironment({...settings(),[prop]:'false'},'stage'),
      /PUBLIC_ISOLATION_NOT_READY/);
  }
  assert.throws(()=>validateImporterEnvironment({...settings(),
    NYX_STORAGE_ENCRYPTION_KEY:'malformed'},'stage'),/KEY_INVALID/);
  assert.throws(()=>validateImporterEnvironment(settings(),'unknown'),
    /IMPORT_MODE_INVALID/);
});

test('without legacy settings, both activation modes remain available',async()=>{
  const {validateImporterEnvironment}=await importer();
  for(const mode of ['stage','stage-six','finalize','finalize-six']){
    const result=validateImporterEnvironment(settings(),mode);
    assert.equal(result.key.length,32);
    result.key.fill(0);
  }
});
