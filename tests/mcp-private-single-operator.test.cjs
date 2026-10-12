const {test}=require('node:test');
const assert=require('node:assert/strict');
const {McpAuthService}=require('../dist/mcp/mcp-auth.service');
const vars=['NYX_PRIVATE_OAUTH_SUBJECTS','NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED'];
async function authorized(subject,subjects,mode='private',connectors='false'){
 const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
 process.env.NYX_PRIVATE_OAUTH_SUBJECTS=subjects;
 process.env.NYX_DEPLOYMENT_MODE=mode;
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED=connectors;
 try{
  const service=new McpAuthService();
  service.verify=async()=>({sub:subject,scope:'nyx.read nyx.write'});
  const response={locals:{},statusCode:200,
   status(code){this.statusCode=code;return this;},
   json(payload){this.payload=payload;return this;},
   setHeader(){}};
  const approved=await service.authorize({headers:{authorization:'Bearer mock-token'}},response);
  return {approved,code:response.statusCode,subject:response.locals.nyxSubject};
 }finally{for(const [k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;}
}
test('one authenticated private operator may use legacy shared Rclone',async()=>{
 assert.deepEqual(await authorized('operator','operator'),{approved:true,code:200,subject:'operator'});
});
test('two allowlisted private subjects are rejected until per-user storage isolation exists',async()=>{
 const alice=await authorized('alice','alice,bob');
 const bob=await authorized('bob','alice,bob');
 assert.equal(alice.approved,false);assert.equal(alice.code,403);
 assert.equal(bob.approved,false);assert.equal(bob.code,403);
});
test('public connector-only mode retains multi-tenant GitHub connection access',async()=>{
 const result=await authorized('bob','alice,bob','public','true');
 assert.equal(result.approved,true);
});
