const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {verifiedGooglePictureUrl}=require('../dist/mcp/mcp-auth.service');
const source=fs.readFileSync(path.join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');

test('Google profile photo must come from an explicitly allowed signed provider image URL',()=>{
 assert.equal(verifiedGooglePictureUrl('https://lh3.googleusercontent.com/a/ACg8_example=s96-c'),
  'https://lh3.googleusercontent.com/a/ACg8_example=s96-c');
 for(const url of [undefined,null,'', 'javascript:alert(1)', 'data:image/svg+xml,evil',
  'http://lh3.googleusercontent.com/a/x','https://lh3.googleusercontent.com.evil.com/a/x',
  'https://evil.example/avatar.png','https://lh3.googleusercontent.com/a/x?token=private',
  'https://lh3.googleusercontent.com/a/x?token=secret',
  'https://lh3.googleusercontent.com/a/x#fragment']){
   assert.equal(verifiedGooglePictureUrl(url),null,String(url));
 }
});

test('multi-account profile MCP tool has stable opaque identity and schema',()=>{
 assert.match(source,/server\.registerTool\('get_profile'/);
 assert.match(source,/'openai\/profile':true/);
 assert.match(source,/outputSchema:z\.object\(/);
 assert.match(source,/id:z\.string\(\)\.min\(1\)/);
 assert.match(source,/createHash\('sha256'\)\.update\('nestnyx-profile-v1:'\+owner\)/);
 assert.match(source,/const owner=this\.connectorOwner\(\)/);
 assert.match(source,/structuredContent:profile/);
 assert.match(source,/signed\?\.email/);
 assert.doesNotMatch(source,/id:\s*signed\?\.email/);
});

test('MCP resource CSP permits only NestNyx brand and Google photo source',()=>{
 assert.match(source,/resourceDomains:\[\.\.\.\(CONNECTIONS_PANEL_BRAND_ORIGIN\?/);
 assert.match(source,/https:\/\/lh3\.googleusercontent\.com/);
});

test('namespaced issuer-signed Auth0 profile may supply image, without changing OAuth tenant',async t=>{
 const {McpAuthService}=require('../dist/mcp/mcp-auth.service');
 const keys=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
   'NYX_OAUTH_SCOPES','NYX_OAUTH_PROFILE_CLAIM'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys){
   if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
 }});
 Object.assign(process.env,{
   NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
   NYX_OAUTH_SCOPES:'nyx.read,nyx.write',
   NYX_OAUTH_PROFILE_CLAIM:'https://app.example.invalid/profile',
 });
 const auth=new McpAuthService();
 auth.verify=async()=>({
   sub:'google-oauth2|123456789012345678901',
   scope:'nyx.read nyx.write',
   'https://app.example.invalid/profile':{
      picture:'https://lh3.googleusercontent.com/a/example=s96-c',
   },
 });
 const response={locals:{},status(c){this.statusCode=c;return this;},
   json(x){this.body=x;return this;}};
 assert.equal(await auth.authorize({headers:{authorization:'Bearer sample'}},response),true);
 assert.equal(response.locals.nyxSubject,'google-oauth2|123456789012345678901');
 assert.equal(response.locals.nyxProfilePicture,'https://lh3.googleusercontent.com/a/example=s96-c');
 assert.equal(response.locals.nyxVerifiedEmail,null);
});
