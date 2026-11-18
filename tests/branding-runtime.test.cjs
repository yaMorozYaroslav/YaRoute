const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const icon=name=>fs.readFileSync(path.join(__dirname,'..','public','branding',name));
const {BrandingController}=require('../dist/branding.controller');

test('Dev and Tester blue icon files exist with identical valid PNG bytes',()=>{
  const blue=icon('icon.png'),alias=icon('nestnyx-dev.png');
  assert.deepEqual(blue,alias);
  assert.ok(blue.length>24&&blue.length<10000);
  assert.equal(blue.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(blue.readUInt32BE(16),96);
  assert.equal(blue.readUInt32BE(20),96);
});
test('server route uses registered branding controller and returns blue image',async()=>{
  const moduleText=fs.readFileSync(path.join(__dirname,'..','src','app.module.ts'),'utf8');
  assert.match(moduleText,/import \{ BrandingController \} from '\.\/branding\.controller'/);
  assert.match(moduleText,/controllers:\s*\[HealthController, BrandingController\]/);
  const sent={headers:{},setHeader(k,v){this.headers[k]=v;return this},
     type(value){this.mime=value;return this},
     send(value){this.body=value;return this}};
  await new BrandingController().icon(sent);
  assert.equal(sent.mime,'image/png');
  assert.deepEqual(sent.body,icon('icon.png'));
  assert.equal(sent.headers['X-Content-Type-Options'],'nosniff');
});
