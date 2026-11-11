const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {
  signPrivateBrokerDelegation,verifyPrivateBrokerDelegation,privateBrokerPath,
} = require('../dist/connectors/private-legacy-delegation');
const {PrivateLegacyBrokerService} = require('../dist/connectors/private-legacy-broker.service');
const {PrivateLegacyBrokerClient} = require('../dist/connectors/private-legacy-broker.client');

const key=randomBytes(32).toString('base64');
const now=1900000000;
const expected={
  issuer:'https://public-service.herokuapp.com',
  audience:'https://private-service.herokuapp.com/internal/private-legacy/execute',
  mcpIssuer:'https://issuer.example.com',
  mcpSubject:'google-oauth2|owner_test123',
  googleSubject:'1234567890',
};
function claims(overrides={}){
  return {v:1,iss:expected.issuer,aud:expected.audience,
    mcpIssuer:expected.mcpIssuer,mcpSubject:expected.mcpSubject,
    googleSubject:expected.googleSubject,op:'list',root:'MAIN',
    path:'safe/path',jti:randomBytes(16).toString('hex'),iat:now,exp:now+30,
    ...overrides};
}
const names=['NYX_PRIVATE_BROKER_SERVER_ENABLED','NYX_DEPLOYMENT_MODE',
  'NYX_PUBLIC_URL','NYX_PRIVATE_BROKER_EXPECTED_PUBLIC_URL','NYX_OAUTH_ISSUER',
  'NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT','NYX_PRIVATE_BROKER_GOOGLE_SUBJECT',
  'NYX_PRIVATE_BROKER_SHARED_KEY_B64','NYX_PRIVATE_BROKER_ALLOWED_AREAS',
  'NYX_PRIVATE_OAUTH_SUBJECTS','DATABASE_URL',
  'NYX_PRIVATE_BROKER_CLIENT_ENABLED','NYX_PRIVATE_BROKER_URL',
  'NYX_PRIVATE_OWNER_LINK_ENABLED','NYX_PUBLIC_CONNECTORS_ENABLED',
  'NYX_MULTIUSER_RCLONE_ENABLED','RCLONE_CONFIG_B64'];
function env(t,values){
  const original=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  t.after(()=>{for(const[n,v] of Object.entries(original)){
    if(v===undefined)delete process.env[n];else process.env[n]=v;
  }});
  for(const[n,v]of Object.entries(values))process.env[n]=v;
}

test('broker HMAC proof binds exact audience, both identities, path and short expiry',()=>{
  const token=signPrivateBrokerDelegation(claims(),key,now);
  assert.deepEqual(verifyPrivateBrokerDelegation(token,key,expected,now).root,'MAIN');
  assert.throws(()=>verifyPrivateBrokerDelegation(token,key,{...expected,googleSubject:'someone-else'},now),
    /TOKEN_DENIED/);
  assert.throws(()=>verifyPrivateBrokerDelegation(token,key,{...expected,audience:'https://evil.example.com'},now),
    /TOKEN_DENIED/);
  assert.throws(()=>verifyPrivateBrokerDelegation(token,key,expected,now+31),/TOKEN_DENIED/);
  assert.throws(()=>verifyPrivateBrokerDelegation(token,randomBytes(32).toString('base64'),expected,now),
    /TOKEN_DENIED/);
  const segments=token.split('.');
  segments[0]=segments[0].slice(0,-1)+(segments[0].endsWith('A')?'B':'A');
  assert.throws(()=>verifyPrivateBrokerDelegation(segments.join('.'),key,expected,now),
    /TOKEN_DENIED/);
  for(const path of ['../outside','/absolute','safe/../outside','remote:other','unsafe\\path']) {
    assert.throws(()=>privateBrokerPath(path),/PATH_DENIED/);
    assert.throws(()=>signPrivateBrokerDelegation(claims({path}),key,now),/CLAIMS_INVALID/);
  }
});

test('private broker rejects foreign roots and replay and returns only safe file fields',async t=>{
  env(t,{
    NYX_PRIVATE_BROKER_SERVER_ENABLED:'true',NYX_DEPLOYMENT_MODE:'private',
    NYX_PUBLIC_URL:'https://private-service.herokuapp.com',
    NYX_PRIVATE_BROKER_EXPECTED_PUBLIC_URL:'https://public-service.herokuapp.com',
    NYX_OAUTH_ISSUER:expected.mcpIssuer,
    NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:expected.mcpSubject,
    NYX_PRIVATE_BROKER_GOOGLE_SUBJECT:expected.googleSubject,
    NYX_PRIVATE_BROKER_SHARED_KEY_B64:key,NYX_PRIVATE_BROKER_ALLOWED_AREAS:'MAIN',
    NYX_PRIVATE_OAUTH_SUBJECTS:expected.mcpSubject,
    DATABASE_URL:'postgresql://placeholder.invalid/unused',
  });
  const used=new Set();let calls=0;
  const client={
    query:async(sql,args=[])=>{
      if(sql.includes('INSERT INTO nyx_private_broker_replay_v1')){
        if(used.has(args[0]))return {rowCount:0,rows:[]};
        used.add(args[0]);return {rowCount:1,rows:[{jti:args[0]}]};
      }
      if(sql.includes('INSERT INTO nyx_private_broker_rate_v1'))
        return {rowCount:1,rows:[{count:++calls}]};
      return {rowCount:1,rows:[]};
    },
    release(){},
  };
  const reads=[];
  const svc=new PrivateLegacyBrokerService({
    list:async(root,path)=>{reads.push([root,path]);
      return [{Name:'report.txt',IsDir:false,Size:123,Hashes:{md5:'secret'},Metadata:{secret:'hide'}}];},
  });
  svc.pool={connect:async()=>client,end:async()=>{}};
  const token=signPrivateBrokerDelegation(claims(),key,now);
  const oldNow=Date.now;Date.now=()=>now*1000;
  t.after(()=>{Date.now=oldNow;});
  const result=await svc.execute('NyxBroker '+token);
  assert.deepEqual(result,{schema:'nyx.private-legacy-broker.v1',
    entries:[{name:'report.txt',isDir:false,size:123}]});
  assert.deepEqual(reads,[['MAIN','safe/path']]);
  await assert.rejects(()=>svc.execute('NyxBroker '+token),/ACCESS_DENIED/);
  await assert.rejects(()=>svc.execute('NyxBroker '+
    signPrivateBrokerDelegation(claims({root:'OTHER'}),key,now)),/ACCESS_DENIED/);
  process.env.NYX_PRIVATE_OAUTH_SUBJECTS=expected.mcpSubject+',another-user';
  await assert.rejects(()=>svc.execute('NyxBroker '+
    signPrivateBrokerDelegation(claims(),key,now)),/CONFIGURATION_INVALID/);
});

test('public broker client requires verified owner and never inherits private Rclone config',async t=>{
  env(t,{
    NYX_PRIVATE_BROKER_CLIENT_ENABLED:'true',NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PRIVATE_OWNER_LINK_ENABLED:'true',
    NYX_PUBLIC_URL:expected.issuer,
    NYX_PRIVATE_BROKER_URL:'https://private-service.herokuapp.com',
    NYX_PRIVATE_BROKER_SHARED_KEY_B64:key,
  });
  // Deliberately leave no production operator Rclone variables in this pilot.
  delete process.env.RCLONE_CONFIG_B64;
  const link={trustedBrokerIdentity:async owner=>{
    if(owner!=='oauth:'+expected.mcpSubject)throw Error('NOT_OWNER');
    return {mcpIssuer:expected.mcpIssuer,mcpSubject:expected.mcpSubject,
      googleSubject:expected.googleSubject};
  }};
  const svc=new PrivateLegacyBrokerClient(link);
  const savedFetch=global.fetch;
  t.after(()=>{global.fetch=savedFetch;});
  let called=false;
  global.fetch=async(url,options)=>{
    called=true;
    assert.equal(url,expected.audience);
    const token=options.headers.authorization.slice(10);
    const payload=verifyPrivateBrokerDelegation(token,key,{
      ...expected,issuer:expected.issuer,
      audience:expected.audience,
    },Math.floor(Date.now()/1000));
    assert.equal(payload.op,'roots');
    return {ok:true,text:async()=>JSON.stringify({
      schema:'nyx.private-legacy-broker.v1',roots:['MAIN']})};
  };
  // The public issuer is independent of the MCP issuer, and must be the
  // service origin. Validate this with a locally configured example.
  const result=await svc.roots('oauth:'+expected.mcpSubject);
  assert.deepEqual(result.roots,['MAIN']);
  assert.equal(called,true);
  called=false;
  await assert.rejects(()=>svc.roots('oauth:another-user'),/NOT_OWNER/);
  assert.equal(called,false);
  process.env.RCLONE_CONFIG_B64='not-a-real-secret';
  await assert.rejects(()=>svc.roots('oauth:'+expected.mcpSubject),
    /LEGACY_CONFIG_FORBIDDEN/);
});
