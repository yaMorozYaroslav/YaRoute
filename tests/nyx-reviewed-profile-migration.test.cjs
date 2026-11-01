const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const sourceText=fs.readFileSync('config/nyx-runtime-profile.json','utf8');
const blob=text=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const text=obj=>JSON.stringify(obj,null,2)+'\n';

// Independent copy of the observed Tester profile's ten legacy leaf values.
function oldTesterProfile(){
 const profile=JSON.parse(sourceText);
 profile.cliSha256='70e8cd6a1e4c52c2a21145ab02cdccb36ceab5f1fcb0f368d32acaa4e8b6c1c4';
 const normal=profile.commands.ini.sources.normal;
 normal.find(x=>x.key==='todo_30').ref.path='Documents/Notepad/0_active/todo_30.md';
 normal.find(x=>x.key==='todo_90').ref.path='Documents/Notepad/1_always/todo_90.md';
 normal.find(x=>x.key==='togive').ref.path='Documents/Notepad/0_active/togive.md';
 const older={
  temp_paths:['🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_paths.json','e2a39572d91c30d1bc5cb0736ad4ed9eda07696453339750c2daa7f63ff49d89'],
  temp_nyxcli:['🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_nyxcli.json','766bbe091201ad466ecd35d103268ff5ceb9bef90e771d47c317e6a7431cc7ef'],
  active_key:['🪼👁️📡YaRoute/0_repository/3_template/staging/drafts/temp_files/temp_key_20260929_0605.json','206c2c19e000ea5dc4969279e1d55e8afeb76d50c080dfc433f99f40dffe4c18'],
 };
 for(const pin of profile.keySources){
  pin.ref.path=older[pin.key][0];pin.sha256=older[pin.key][1];
 }
 return profile;
}
test('only the observed exact Dev/Tester profile pair is accepted',async()=>{
 const {reconcileReviewedProfileMigration,reviewedProfileBlobs}=await import('../scripts/nyx-reviewed-profile-migration.mjs');
 const targetText=text(oldTesterProfile());
 assert.equal(blob(sourceText),reviewedProfileBlobs.source);
 assert.equal(blob(targetText),reviewedProfileBlobs.target);
 const resolution=reconcileReviewedProfileMigration(sourceText,targetText,reviewedProfileBlobs);
 assert.equal(resolution.content,sourceText);
 assert.equal(resolution.reviewId,'noteflow-profile-2026-11-01');
 const result=JSON.parse(resolution.content);
 assert.equal(result.keySources.find(x=>x.key==='active_key').mode,undefined);
 assert.deepEqual(result.keySources.filter(x=>x.mode==='observe').map(x=>x.key),['temp_paths','temp_nyxcli']);
});
test('reject arbitrary CLI, trusted-key or source-schema substitutions',async()=>{
 const {reconcileReviewedProfileMigration,reviewedProfileBlobs}=await import('../scripts/nyx-reviewed-profile-migration.mjs');
 const targetText=text(oldTesterProfile());
 const accepted=()=>reconcileReviewedProfileMigration(sourceText,targetText,reviewedProfileBlobs);
 assert.doesNotThrow(accepted);
 assert.throws(()=>reconcileReviewedProfileMigration(sourceText,targetText,{...reviewedProfileBlobs,sourceSchema:'f'.repeat(40)}),/SCHEMA_PAIR_CHANGED/);
 assert.throws(()=>reconcileReviewedProfileMigration(sourceText,targetText,{...reviewedProfileBlobs,target:'f'.repeat(40)}),/UNREVIEWED_BLOB_PAIR/);
 const changed=oldTesterProfile();changed.keySources.find(x=>x.key==='active_key').mode='observe';
 assert.throws(()=>reconcileReviewedProfileMigration(sourceText,text(changed),reviewedProfileBlobs),/BLOB_CONTENT_MISMATCH/);
 const modified=JSON.parse(sourceText);modified.cliSha256='f'.repeat(64);
 assert.throws(()=>reconcileReviewedProfileMigration(text(modified),targetText,reviewedProfileBlobs),/BLOB_CONTENT_MISMATCH/);
});
