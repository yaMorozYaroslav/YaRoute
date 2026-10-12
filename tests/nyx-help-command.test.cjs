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
 for(const command of ['hel','HEL','HeL']){
  const plan=resolver.resolve(bound,{command});
  assert.equal(plan.name,'hel');
  assert.equal(plan.contract.adapter,'context.help.v1');
 }
 assert.throws(()=>resolver.resolve(bound,{command:'help',args:['key']}),/UNKNOWN_COMMAND/);
 assert.throws(()=>resolver.resolve(bound,{command:'help',args:['oGN']}),/UNKNOWN_COMMAND/);
 assert.throws(()=>resolver.resolve(bound,{command:'help',payload:{title:'x',summary:'y'}}),/UNKNOWN_COMMAND/);
});
test('only canonical short key hel returns full executable inventory without writing',async()=>{
 const {executor}=make();
 const canonical=await executor.execute({command:'hel'});
 await assert.rejects(()=>executor.execute({command:'help'}),/UNKNOWN_COMMAND/);
 assert.equal(canonical.status,'COMPLETE');
 assert.match(canonical.markdown,/# Nyx CLI — canonical command reference/);
 assert.match(canonical.markdown,/nyx hel/);
 assert.match(canonical.markdown,/nyx ini/);
 assert.match(canonical.markdown,/nyx key/);
 assert.equal(canonical.human_mirror.filename,'nyxcli.md');
 assert.equal(canonical.human_mirror.verified_against_live_mirror,false);
 assert.equal(canonical.commands.find(x=>x.name==='hel').canonicalSyntax,'Nyxhel');
 assert.equal(canonical.schema,'nyx.context.v1');
 assert.equal(canonical.command_count,4);
 assert.equal(canonical.metadata.command,'hel');
 assert.equal(canonical.metadata.mutation,'none');
 assert.equal(canonical.metadata.canonical.head,'head_db_v028.zip');
 assert.equal(canonical.scope_rules.default,'local and omitted');
 assert.equal(canonical.scope_rules.chain,'command local modifiers stop at x');
 assert.equal(canonical.commands.find(x=>x.name==='hel').executable,true);
 assert.deepEqual(canonical.commands.find(x=>x.name==='hel').aliases,[]);
 assert.equal(canonical.syntax.label,'Help');
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
 assert.throws(()=>resolver.resolve(fake,{command:'hel'}),/HELP_CONTRACT_UNSAFE/);
});
test('MCP exposes the short key nyx_hel only; full Help is descriptive',()=>{
 const src=repo('src/mcp/mcp.service.ts');
 const start=src.indexOf("server.registerTool(\n      'nyx_hel'");
 const end=src.indexOf("server.registerTool(\n      'nyx_execute'",start);
 assert.ok(start>=0&&end>start);
 assert.match(src.slice(start,end),/readOnlyHint: true/);
 assert.match(src.slice(start,end),/this\.commands\.execute\(\{ command: 'hel' \}/);
 assert.match(src,/hel: \{ tool: 'nyx_hel', command: 'hel'/);
 assert.doesNotMatch(src,/'nyx_help'/);
});

test('help covers every canonical command in Head order, including missing-order additions',async()=>{
 const all=['hel','ini','key','mat','ske','inf','com','can','fin','upd','sav',
   'gen','rec','che','dec','ded','execute','ext','abs','sum','ver'];
 const order=all.filter(x=>x!=='ver');
 const {executor}=make();
 const original=executor.registry.current;
 executor.registry.current=async()=>({
  cli:cliSchema.parse({
   schema:'nyx.yarocli.v1',version:'v004',
   canonical_command_order:order,
   human_mirror:{filename:'nyxcli.md'},
   commands:Object.fromEntries(all.map(name=>[name,{
    purpose:'Official Head explanation for '+name,
    ...(name==='key'?{dependency:'active key list'}:{}),
   }])),
  }),
  hash:'0'.repeat(64),
 });
 const originalProfile=executor.profiles.apply;
 executor.profiles.apply=async(_,cli)=>({cli:{
  ...cli,commands:{
   ...cli.commands,
   hel:{...cli.commands.hel,execution:loadedProfile.commands.hel},
   ini:{...cli.commands.ini,execution:loadedProfile.commands.ini},
   sum:{...cli.commands.sum,execution:loadedProfile.commands.sum},
  },
 },hash:'test-profile'});
 const result=await executor.execute({command:'hel'});
 assert.equal(result.command_count,21);
 assert.deepEqual(result.commands.map(x=>x.name),all);
 assert.ok(result.commands.every(x=>result.markdown.includes('nyx '+x.name)));
 assert.equal(result.commands.find(x=>x.name==='key').details.dependency,'active key list');
 assert.equal(result.commands.filter(x=>x.executable).length,3);
 assert.equal(result.human_mirror.completeness,'not-guaranteed');
 executor.registry.current=original;
 executor.profiles.apply=originalProfile;
});
