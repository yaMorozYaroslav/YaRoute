const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PrivateLegacyOwnerLinkService} =
  require('../dist/connectors/private-legacy-owner-link.service');

const keys = ['NYX_PRIVATE_OWNER_LINK_ENABLED','NYX_DEPLOYMENT_MODE',
  'NYX_PUBLIC_CONNECTORS_ENABLED','NYX_MULTIUSER_RCLONE_ENABLED',
  'NYX_PRIVATE_LEGACY_OWNER_GOOGLE_EMAIL','NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT',
  'NYX_PRIVATE_OWNER_GOOGLE_CLIENT_ID','NYX_PRIVATE_OWNER_GOOGLE_CLIENT_SECRET',
  'NYX_OAUTH_ISSUER','NYX_PUBLIC_URL'];
const operator = 'oauth:approved-owner-test';
const email = 'sole-owner@example.com';

function setup(t) {
  const previous = Object.fromEntries(keys.map(k => [k,process.env[k]]));
  t.after(() => {
    for (const [k,v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  Object.assign(process.env,{
    NYX_PRIVATE_OWNER_LINK_ENABLED:'true',
    NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PRIVATE_LEGACY_OWNER_GOOGLE_EMAIL:email,
    NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'approved-owner-test',
    NYX_PRIVATE_OWNER_GOOGLE_CLIENT_ID:'test-client-id.apps.googleusercontent.com',
    NYX_PRIVATE_OWNER_GOOGLE_CLIENT_SECRET:'synthetic-only-secret',
    NYX_OAUTH_ISSUER:'https://auth.example.test',
    NYX_PUBLIC_URL:'https://nyx-public.example.test',
  });
}

function fixture() {
  const svc = new PrivateLegacyOwnerLinkService();
  svc.key = Buffer.alloc(32,7);
  const states = new Map();
  let ownerLink;
  const statements = [];
  svc.pool = {query:async(sql,args=[])=>{
    statements.push({sql,args});
    if(sql.startsWith('DELETE FROM nyx_private_owner_link_states_v1 WHERE mcp_subject=')) {
      for(const [key,value] of states) if(value.mcp_subject===args[0])states.delete(key);
      return {rowCount:0,rows:[]};
    }
    if(sql.startsWith('INSERT INTO nyx_private_owner_link_states_v1')) {
      states.set(args[0],{mcp_subject:args[1],encrypted_challenge:args[2]});
      return {rowCount:1,rows:[]};
    }
    if(sql.startsWith('DELETE FROM nyx_private_owner_link_states_v1 WHERE digest=')) {
      const found=states.get(args[0]);states.delete(args[0]);
      return {rowCount:found?1:0,rows:found?[found]:[]};
    }
    if(sql.startsWith('SELECT mcp_issuer,mcp_subject,google_email')) {
      return {rowCount:ownerLink?1:0,rows:ownerLink?[ownerLink]:[]};
    }
    if(sql.startsWith('INSERT INTO nyx_private_owner_links_v1')) {
      const candidate={mcp_issuer:args[0],mcp_subject:args[1],
        google_subject:args[2],google_email:args[3]};
      if(!ownerLink)ownerLink=candidate;
      else if(Object.keys(candidate).some(k=>candidate[k]!==ownerLink[k])) {
        return {rowCount:0,rows:[]};
      }
      return {rowCount:1,rows:[{id:1}]};
    }
    throw Error('UNEXPECTED_QUERY');
  }};
  return {svc,states,statements,getLink:()=>ownerLink};
}

test('owner-only OAuth begin is PKCE/nonce-bound, identity-only and never requests Drive scopes',async t=>{
  setup(t);
  const {svc,states}=fixture();
  assert.deepEqual(await svc.status('oauth:other-user'),{eligible:false,linked:false});
  await assert.rejects(()=>svc.begin('oauth:other-user'),/NOT_AUTHORIZED/);
  assert.equal(states.size,0);
  const response=await svc.begin(operator);
  const url=new URL(response.url);
  assert.equal(url.origin,'https://accounts.google.com');
  assert.equal(url.pathname,'/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'),'openid email');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('nonce'));
  assert.equal(url.searchParams.get('redirect_uri'),
    'https://nyx-public.example.test/connect/private-owner/callback');
  assert.equal(response.privateRcloneAvailable,false);
  assert.equal(JSON.stringify(response).includes('synthetic-only-secret'),false);
  assert.equal(states.size,1);
});

test('callback consumes one-use state, verifies Google subject and keeps tokens out of registry',async t=>{
  setup(t);
  const {svc,getLink,states}=fixture();
  const response=await svc.begin(operator);
  const url=new URL(response.url);
  const nonce=url.searchParams.get('nonce');
  let checks=0,fetches=0;
  svc.verifier={verify:async(token,expected)=>{
    checks++;
    assert.equal(token,'synthetic-identity-token');
    assert.equal(expected.nonce,nonce);
    assert.equal(expected.clientId,'test-client-id.apps.googleusercontent.com');
    return {issuer:'https://accounts.google.com',subject:'stable-google-owner',
      email,emailVerified:true};
  }};
  const previous=global.fetch;
  global.fetch=async(_url,init)=>{
    fetches++;
    assert.equal(_url,'https://oauth2.googleapis.com/token');
    assert.equal(init.body.get('code_verifier').length>40,true);
    return {ok:true,text:async()=>JSON.stringify({id_token:'synthetic-identity-token'})};
  };
  t.after(()=>{global.fetch=previous;});
  const state=url.searchParams.get('state');
  assert.deepEqual(await svc.complete(state,'authorization-code-test'),
    {status:'identity_linked',privateRcloneAvailable:false});
  assert.deepEqual(await svc.status(operator),
    {eligible:true,linked:true,privateRcloneAvailable:false});
  assert.equal(checks,1);
  assert.equal(fetches,1);
  assert.equal(states.size,0);
  assert.deepEqual(getLink(),{
    mcp_issuer:'https://auth.example.test',mcp_subject:'approved-owner-test',
    google_subject:'stable-google-owner',google_email:email,
  });
  await assert.rejects(()=>svc.complete(state,'authorization-code-test'),/STATE_EXPIRED/);
  assert.equal(fetches,1);
});

test('wrong Google account and changed Google subject never transfer the singleton owner',async t=>{
  setup(t);
  const {svc,getLink}=fixture();
  let sub='stable-google-owner',shownEmail=email;
  svc.verifier={verify:async()=>({
    issuer:'https://accounts.google.com',subject:sub,email:shownEmail,emailVerified:true,
  })};
  const previous=global.fetch;
  global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({id_token:'synthetic'})});
  t.after(()=>{global.fetch=previous;});
  const start=async()=>new URL((await svc.begin(operator)).url).searchParams.get('state');
  shownEmail='other@example.com';
  await assert.rejects(async()=>svc.complete(await start(),'code-test'),/IDENTITY_DENIED/);
  assert.equal(getLink(),undefined);
  shownEmail=email;
  assert.equal((await svc.complete(await start(),'code-test')).status,'identity_linked');
  const baseline=getLink();
  sub='new-google-account';
  await assert.rejects(async()=>svc.complete(await start(),'code-test'),/CONFLICT/);
  assert.deepEqual(getLink(),baseline);
});

test('disabled feature or private deployment cannot start the public owner link',async t=>{
  setup(t);
  const {svc}=fixture();
  process.env.NYX_PRIVATE_OWNER_LINK_ENABLED='false';
  await assert.rejects(()=>svc.begin(operator),/NOT_ENABLED/);
  process.env.NYX_PRIVATE_OWNER_LINK_ENABLED='true';
  process.env.NYX_DEPLOYMENT_MODE='private';
  await assert.rejects(()=>svc.begin(operator),/NOT_ENABLED/);
});
