import test from 'node:test';
import assert from 'node:assert/strict';
import {validNeonUrl, inspectState, buildPatch} from '../scripts/nyx-termux-public-cutover.mjs';

const devUrl = 'https://dev-nest-nyx-0df80c227630.herokuapp.com';
const proUrl = 'https://nest-nyx-pro-example.herokuapp.com';
const at=String.fromCharCode(64);
const neon = `postgresql://u:pw${at}ep-falling-silence-b9rcrzay-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
const devDb = `postgresql://u:pw${at}private-dev.invalid/neondb?sslmode=require`;
const proDb = `postgresql://u:pw${at}private-pro.invalid/neondb?sslmode=require`;
const owner={email:'operator'+at+'example.invalid'};
const devApp={web_url:devUrl,owner};
const proApp={web_url:proUrl,owner};
const dev = {NYX_DEPLOYMENT_MODE:'private',NYX_PUBLIC_URL:devUrl,
  NYX_OAUTH_ISSUER:'https://dev-q8g77208l2kp7iqu.eu.auth0.com/',
  RCLONE_CONFIG_B64:'private-dev-secret',NYX_PRIVATE_OAUTH_SUBJECTS:'legacy',
  NYX_PRIVATE_BROKER_SHARED_KEY_B64:'legacy-key',NYX_API_KEY:'legacy-api',DATABASE_URL:devDb};
const pro = {NYX_DEPLOYMENT_MODE:'private',NYX_PUBLIC_URL:proUrl,
  RCLONE_CONFIG_B64:'private-pro-secret',
  NYX_PRIVATE_OAUTH_SUBJECTS:'google-oauth2|12345678901234567890',
  NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'google-oauth2|12345678901234567890',
  NYX_PRIVATE_SINGLE_GOOGLE_OWNER:'true',
  DATABASE_URL:proDb,NYX_STORAGE_ENCRYPTION_KEY:'pro-key'};
const state = () => inspectState(dev,pro,devApp,proApp,[],[{size:'eco',quantity:1}]);
const input = () => ({databaseUrl:neon,proDatabaseUrl:proDb,
  googleClientId:'1234567890-abc.apps.googleusercontent.com',
  googleClientSecret:'somegoogleclientsecret',encryptionKey:'fresh-key'});

test('requires distinct Neon URL with TLS and approved public Neon hostname',()=>{
  assert.ok(validNeonUrl(neon,devDb,proDb));
  assert.equal(validNeonUrl(proDb,devDb,proDb),false);
  assert.equal(validNeonUrl(devDb,devDb,proDb),false);
  assert.equal(validNeonUrl(neon.replace('sslmode=require','sslmode=disable'),devDb,proDb),false);
  assert.equal(validNeonUrl(neon.replace('neon.tech','herokuapp.com'),devDb,proDb),false);
});
test('strips Dev-only legacy private variables and never changes Pro',()=>{
  const original=structuredClone(pro);
  const patch=buildPatch(dev,state(),input());
  for(const key of ['RCLONE_CONFIG_B64','NYX_PRIVATE_OAUTH_SUBJECTS',
    'NYX_PRIVATE_BROKER_SHARED_KEY_B64','NYX_API_KEY']) assert.equal(patch[key],null);
  assert.equal(patch.DATABASE_URL,neon);
  assert.equal(patch.NYX_DEPLOYMENT_MODE,'public');
  assert.equal(patch.NYX_PRIVATE_OWNER_LINK_ENABLED,'false');
  assert.equal(patch.NYX_PRIVATE_BROKER_CLIENT_ENABLED,'false');
  assert.deepEqual(pro,original);
});
test('blocks Heroku Postgres and non-Eco formation',()=>{
  assert.throws(()=>inspectState(dev,pro,devApp,proApp,
    [{plan:{name:'heroku-postgresql:essential-0'}}],[]),/HEROKU_POSTGRES_ADDON_PRESENT/);
  assert.throws(()=>inspectState(dev,pro,devApp,proApp,
    [],[{size:'standard-1x',quantity:1}]),/NON_ECO_DYNO_PRESENT/);
});
test('blocks missing Pro private credentials or incorrect owner',()=>{
  assert.throws(()=>inspectState(dev,{...pro,RCLONE_CONFIG_B64:''},
    devApp,proApp),/PRO_PRIVATE_BASELINE_INCOMPLETE/);
  assert.throws(()=>inspectState(dev,pro,devApp,
    {web_url:devUrl,owner}),/HEROKU_ORIGINS_NOT_VERIFIED/);
});
test('public cutover requires a sole, pinned Google owner on private Pro',()=>{
  for(const overrides of [
    {NYX_PRIVATE_SINGLE_GOOGLE_OWNER:'false'},
    {NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:''},
    {NYX_PRIVATE_OAUTH_SUBJECTS:pro.NYX_PRIVATE_OAUTH_SUBJECTS+',google-oauth2|222222222222'},
    {NYX_PRIVATE_OAUTH_SUBJECTS:pro.NYX_PRIVATE_OAUTH_SUBJECTS+','+pro.NYX_PRIVATE_OAUTH_SUBJECTS},
    {NYX_PRIVATE_OAUTH_SUBJECTS:'auth0|some-other-identity',
      NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'auth0|some-other-identity'},
  ]) assert.throws(()=>inspectState(dev,{...pro,...overrides},devApp,proApp),
    /PRO_SINGLE_GOOGLE_OWNER_NOT_VERIFIED/);
});
test('prevents silent encryption-key rotation after successful public cutover',()=>{
  const first=buildPatch(dev,state(),input());
  const configured={...dev,...first};
  for(const [key,value] of Object.entries(configured)) if(value===null)delete configured[key];
  const inspected=inspectState(configured,pro,devApp,proApp);
  assert.equal(inspected.alreadyPublic,true);
  assert.throws(()=>buildPatch(configured,inspected,input()),/ALREADY_PUBLIC_NO_KEY_ROTATION/);
});
test('rejects ambiguous partial public environment',()=>{
  assert.throws(()=>inspectState({...dev,NYX_DEPLOYMENT_MODE:'public'},pro,
    devApp,proApp),/PARTIAL_PUBLIC_CONFIG_REQUIRES_MANUAL_REVIEW/);
});
