const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mayUsePrivateLegacyRclone}=require('../dist/connectors/private-legacy-access.policy');

const links=[
  {mcpIssuer:'https://auth.example.test',mcpSubject:'owner-one',
   googleSubject:'google-sub-one',googleEmail:'owner-one@example.com'},
  {mcpIssuer:'https://auth.example.test',mcpSubject:'owner-two',
   googleSubject:'google-sub-two',googleEmail:'owner-two@example.com'},
];
const actor=(subject='owner-one')=>({issuer:'https://auth.example.test',subject});
const google=(subject='google-sub-one',email='owner-one@example.com')=>
 ({issuer:'https://accounts.google.com',subject,email,emailVerified:true});

test('both independently verified, configured Google identities can access private broker',()=>{
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),links),true);
  assert.equal(mayUsePrivateLegacyRclone(actor('owner-two'),
    google('google-sub-two','OWNER-TWO@example.com'),links),true);
});
test('public users and unauthenticated identities cannot enter the legacy vault',()=>{
  assert.equal(mayUsePrivateLegacyRclone(actor('other'),google(),links),false);
  assert.equal(mayUsePrivateLegacyRclone(null,google(),links),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),null,links),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),[]),false);
});
test('unverified email alone is never authorization',()=>{
  assert.equal(mayUsePrivateLegacyRclone(actor(),
    {...google(),emailVerified:false},links),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),
    google('attacker-google-sub','owner-one@example.com'),links),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),
    google('google-sub-one','other@example.com'),links),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),
    {...google(),issuer:'https://untrusted.example.test'},links),false);
});
test('MCP subject, issuer and Google subject must match the SAME configured link',()=>{
  assert.equal(mayUsePrivateLegacyRclone(actor(),
    google('google-sub-two','owner-two@example.com'),links),false);
  assert.equal(mayUsePrivateLegacyRclone({...actor(),issuer:'https://evil.example.test'},
    google(),links),false);
  assert.equal(mayUsePrivateLegacyRclone({...actor(),issuer:'http://auth.example.test'},
    google(),links),false);
});
test('ambiguous or malformed owner-link configuration fails closed',()=>{
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),[links[0],links[0]]),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),
    [links[0],{...links[1],googleSubject:'google-sub-one'}]),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),
    [...links,{...links[0],mcpSubject:'owner-three',googleSubject:'google-three'}]),false);
  assert.equal(mayUsePrivateLegacyRclone(actor(),google(),
    [{...links[0],googleEmail:'not-an-email'}]),false);
});
