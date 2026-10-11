const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
test('GitHub Actions rejects Heroku deployment and broad deployment credentials',async()=>{
 const {prohibitedHerokuActions}=await import(pathToFileURL(path.resolve('scripts/guard-no-heroku-actions.mjs')));
 assert.deepEqual(prohibitedHerokuActions({
  'ci.yml':'name: CI\nsteps:\n - run: npm test\n',
  'heroku.yml':'env:\n  HEROKU_API_KEY: SECRET_REFERENCE',
  'push.yml':'run: git push https://heroku:xxxx@git.heroku.com/app.git HEAD:main',
  'api.yml':'run: curl https://api.heroku.com/apps/myapp/config-vars',
 }),['api.yml','heroku.yml','push.yml']);
 assert.deepEqual(prohibitedHerokuActions({
  'ci.yml':'name: CI\nsteps:\n - run: npm test\n',
  'security-audit.yml':'name: Audit\nsteps:\n - run: node scripts/public-repo-guard.mjs',
 }),[]);
 const checked=spawnSync(process.execPath,['scripts/guard-no-heroku-actions.mjs'],{encoding:'utf8'});
 assert.equal(checked.status,0,checked.stderr);
});
