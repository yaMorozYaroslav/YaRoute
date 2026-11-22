const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { preparePublicIniPlan } = require('../dist/nyx/public-init-plan');

test('assisted public initialization understands GNo without interpreting it as a target', () => {
  const result = preparePublicIniPlan({target:'YaRoute WebArt TechLab EasyWay GNo'});
  assert.deepEqual(result.targets,['YaRoute','WebArt','TechLab','EasyWay']);
  assert.equal(result.scope,'global');
  assert.equal(result.depth,'normal');
  assert.equal(result.modifier,'oGN');
  assert.equal(result.status,'PARTIAL_DIAGNOSTIC');
  assert.equal(result.fif,null);
  assert.equal(result.canonicalReadVerified,false);
  assert.equal(result.privateBootstrapUsed,false);
  assert.deepEqual(result.files_to_paste,[]);
  assert.equal(result.canonicalChanged,false);
});

test('no implicit private grant, no fake source verification and no invented session', () => {
  const result=preparePublicIniPlan({targets:['TechLab','techlab','oLN']});
  assert.deepEqual(result.targets,['TechLab']);
  assert.ok(result.warnings.some(x=>x.includes('does not authorize private')));
  assert.ok(result.sourceManifest.every(x=>x.required===true));
  assert.equal(result.tenantSourceAccess,'separate-authorization-required');
  assert.equal(result.execution,'READ_ONLY_EXTERNAL_SOURCE_PLAN');
});

test('malformed, duplicated or contradictory modifiers fail closed', () => {
  const plan=payload=>preparePublicIniPlan(payload);
  for(const payload of [
    {target:'YaRoute GNo oGN'},
    {target:'GNo'},
    {target:'YaRoute ../secret'},
    {target:'YaRoute GNo',scope:'local'},
    {target:'YaRoute GNo',depth:'deep'},
    {target:'YaRoute',targets:['YaRoute']},
    {targets:Array(17).fill('TechLab')},
  ]) assert.throws(()=>plan(payload));
});

test('public route is registered before private gate; only an external plan is offered', () => {
  const src=readFileSync(join(__dirname,'..','src','mcp','mcp.service.ts'),'utf8');
  const planner=src.indexOf("server.registerTool('nyx_ini_plan'");
  const gate=src.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;");
  const privateIni=src.indexOf("'nyx_ini',",gate);
  assert.ok(planner>=0 && planner<gate && privateIni>gate);
  assert.match(src,/preparePublicIniPlan/);
  const plannerSource=readFileSync(join(__dirname,'..','src','nyx','public-init-plan.ts'),'utf8');
  assert.match(plannerSource,/separate-authorization-required/);
});
