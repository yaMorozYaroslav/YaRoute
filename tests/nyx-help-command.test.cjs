const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {cliSchema,profileSchema}=require('../dist/nyx/runtime.schema');
const {NyxCommandResolver}=require('../dist/nyx/command-resolver');
const {NyxCommandExecutor}=require('../dist/nyx/command-executor.service');
const repo=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const loadedProfile=profileSchema.parse(JSON.parse(repo('config/nyx-runtime-profile.json')));

function make(){
 const cli=cliSchema.parse({
  schema:'nyx.yarocli.v1',version:'v004',
  scope_rules:{default:'local and omitted',chain_scope_rule:'command local modifiers stop at x'},
  commands:{
   hel:{purpose:'List canonical commands, syntax, dependencies, scopes and chaining rules.'},
   ini:{purpose:'Initialize context.'},
   key:{purpose:'Prioritize changes.'},
   sum:{purpose:'Summarize existing handoff.'},
  },
 });
 const bound={...cli,commands:{...cli.commands,
  hel:{...cli.commands.hel,execution:loadedProfile.commands.hel},
  ini:{...cli.commands.ini,execution:loadedProfile.commands.ini},
  sum:{...cli.commands.sum,execution:loadedProfile.commands.sum},
 }};
 const resolver=new NyxCommandResolver();
 const sentinel=()=>{throw new Error('Help must not use storage or mutate resources');};
 const executor=new NyxCommandExecutor(
  {locate:async()=>({canonical:{head:'head_db_v028.zip',body:'body_db_v024.zip',footer:'footer_db_v080.zip'}})},
  {current:async()=>({cli,hash:loadedProfile.cliSha256})},
  resolver,
  {load:sentinel,resolveHandoffs:sentinel},
  {initialize:sentinel,summarize:sentinel,reconfigure:sentinel},
  {apply:async()=>({cli:bound,hash:'runtime-hash'})},
 );
 return {cli,bound,resolver,executor};
}
test('help profile declares a nonmutating adapter bound only to existing canonical hel',()=>{
 assert.deepEqual(Object.keys(loadedProfile.commands).sort(),['hel','ini','sum']);
 assert.equal(loadedProfile.commands.hel.adapter,'context.help.v1');
 assert.equal(loadedProfile.commands.hel.mutation,'none');
 assert.equal(loadedProfile.commands.hel.verification.artifactReadback,false);
 assert.equal(loadedProfile.commands.hel.pathsVisible,false);
 assert.deepEqual(loadedProfile.commands.hel.sources,{basic:[],normal:[],deep:[]});
 const {bound,resolver}=make();
 for(const command of ['hel','help','HeLp']){
  const plan=resolver.resolve(bound,{command});
  assert.equal(plan.name,'hel');
  assert.equal(plan.contract.adapter,'context.help.v1');
 }
 assert.throws(()=>resolver.resolve(bound,{command:'help',args:['key']}),/ARGUMENTS_NOT_ALLOWED/);
 assert.throws(()=>resolver.resolve(bound,{command:'help',args:['oGN']}),/ARGUMENTS_NOT_ALLOWED/);
 assert.throws(()=>resolver.resolve(bound,{command:'help',payload:{title:'x',summary:'y'}}),/PAYLOAD_NOT_SUPPORTED/);
});
test('real hel and help return consistent, canonical executable inventory without writing',async()=>{
 const {executor}=make();
 const canonical=await executor.execute({command:'hel'});
 const compat=await executor.execute({command:'help'});
 assert.deepEqual(compat,canonical);
 assert.equal(canonical.status,'COMPLETE');
 assert.equal(canonical.schema,'nyx.context.v1');
 assert.equal(canonical.command_count,4);
 assert.equal(canonical.metadata.command,'hel');
 assert.equal(canonical.metadata.mutation,'none');
 assert.equal(canonical.metadata.canonical.head,'head_db_v028.zip');
 assert.equal(canonical.scope_rules.default,'local and omitted');
 assert.equal(canonical.scope_rules.chain,'command local modifiers stop at x');
 assert.equal(canonical.commands.find(x=>x.name==='hel').executable,true);
 assert.deepEqual(canonical.commands.find(x=>x.name==='hel').aliases,['help']);
 assert.equal(canonical.commands.find(x=>x.name==='ini').executable,true);
 assert.equal(canonical.commands.find(x=>x.name==='sum').executable,true);
 assert.equal(canonical.commands.find(x=>x.name==='key').executable,false);
 assert.equal(canonical.commands.find(x=>x.name==='key').status,'canonical-only');
 assert.ok(!('files_to_paste' in canonical));
 assert.ok(!('fif' in canonical));
});
test('help cannot invent a canonical command or bypass unsafe bindings',()=>{
 const {bound,resolver}=make();
 const noHel={...bound,commands:{key:bound.commands.key}};
 assert.throws(()=>resolver.resolve(noHel,{command:'help'}),/UNKNOWN_COMMAND/);
 const unsafe={...bound,commands:{...bound.commands,
  hel:{purpose:'unsafe',execution:{...bound.commands.hel.execution,mutation:'conversation-artifact'}}}};
 assert.throws(()=>resolver.resolve(unsafe,{command:'hel'}),/READ_CONTRACT_UNSAFE/);
 const fake={...bound,commands:{...bound.commands,
  hel:{purpose:'unsafe',execution:{...bound.commands.hel.execution,pathsVisible:true}}}};
 assert.throws(()=>resolver.resolve(fake,{command:'help'}),/HELP_CONTRACT_UNSAFE/);
});
test('MCP offers a read-only explicit nyx_help tool without altering Head definitions',()=>{
 const src=repo('src/mcp/mcp.service.ts');
 const start=src.indexOf("server.registerTool(\n      'nyx_help'");
 const end=src.indexOf("server.registerTool(\n      'nyx_execute'",start);
 assert.ok(start>=0&&end>start);
 assert.match(src.slice(start,end),/readOnlyHint: true/);
 assert.match(src.slice(start,end),/this\.commands\.execute\(\{ command: 'hel' \}/);
 assert.match(src,/help: \{ tool: 'nyx_help', command: 'hel'/);
});
