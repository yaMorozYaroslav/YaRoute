const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { cliSchema } = require('../dist/nyx/runtime.schema');
const { NyxCommandResolver } = require('../dist/nyx/command-resolver');
const { NyxCliRegistryService } = require('../dist/nyx/cli-registry.service');
const { NyxResourceResolver } = require('../dist/nyx/resource-resolver.service');
const { NyxCommandExecutor } = require('../dist/nyx/command-executor.service');
const { NyxBootstrapService } = require('../dist/nyx/bootstrap.service');
const { HandoffStore, artifactId, assertNoSecrets } = require('../dist/nyx/handoff-store.service');
const { NyxResourceStore, sha256 } = require('../dist/nyx/resource-store.service');
const { NyxExecutionProfileService } = require('../dist/nyx/execution-profile.service');
const { InitService } = require('../dist/init/init.service');
const ref = path => ({ area: 'MAIN', path });
const locator = { schema: 'nyx.bootstrap.v1', cli: ref('authority.json'), paths: { basic: ref('paths.md'), normal: ref('n_paths.json'), deep: ref('d_paths.json') }, canonical: { head: 'head_fixture.zip', body: 'body_fixture.zip', footer: 'footer_fixture.zip' } };
const source = (key, visible = true) => ({ key, visible, required: true });
const contract = () => ({ adapter: 'context.initialize.v1', depth: { default: 'basic', allowed: ['basic', 'normal', 'deep'] }, arguments: { targets: true, maxTargets: 4 }, pathsVisible: true, sources: { basic: [source('maps'), { ...source('todo'), when: 'targeted' }, { ...source('area:{target}:state'), perTarget: true }, { ...source('area:{target}:config'), perTarget: true }], normal: [source('normal')], deep: [source('deep')] }, mutation: 'conversation-artifact', handoffsKey: 'handoffs', verification: { sourceRead: true, artifactReadback: true }, response: 'nyx.context.v1' });
const makeCli = () => cliSchema.parse({ schema: 'nyx.yarocli.v1', version: 'test-v1', commands: { begin: { aliases: ['start'], execution: contract() } } });
class MemoryResources {
  constructor(files = {}) { this.files = new Map(Object.entries(files)); this.reads = []; this.writes = []; this.stats = 0; }
  async stat(r) { this.stats++; const data = this.files.get(r.path); if (data === undefined) throw new Error('RESOURCE_STAT_FAILED'); return { Size: Buffer.byteLength(data), Hashes: { sha256: sha256(data) } }; }
  async read(r) { this.reads.push(r.path); if (!this.files.has(r.path)) throw new Error('RESOURCE_READ_FAILED'); return this.files.get(r.path); }
  async optionalList(r) { const items = new Map(); for (const p of this.files.keys()) if (p.startsWith(r.path + '/')) { const tail = p.slice(r.path.length + 1), Name = tail.split('/')[0]; items.set(Name, { Name, IsDir: tail.includes('/') }); } return [...items.values()]; }
  async optionalRead(r) { return this.files.get(r.path); }
  async createVerified(r, data) { const old = this.files.get(r.path); if (old !== undefined && old !== data) throw new Error('IMMUTABLE_ARTIFACT_CONFLICT'); this.files.set(r.path, data); this.writes.push(r.path); return { sha256: sha256(data), verified: true }; }
}
function handoffs(resources) {
  const h = new HandoffStore(resources);
  const state = new Map(); let tail = Promise.resolve();
  // Serialized durable-store seam: exercise actual artifact lifecycle independently of PostgreSQL.
  h.locked = (id, action) => { const next = tail.then(() => action(state.get(id), async value => { state.set(id, value); })); tail = next.catch(() => {}); return next; };
  return h;
}
const routes = { maps: ref('maps.md'), todo: ref('todo.md'), handoffs: ref('private/Handoffs'), normal: ref('normal.md'), deep: ref('deep.md'), 'area:Voice:state': ref('voice-state.json'), 'area:Voice:config': ref('voice-config.json'), 'area:oGN:state': ref('ogn-state.json'), 'area:oGN:config': ref('ogn-config.json') };
const markdown = '# Paths\n\n| key | area | path |\n| --- | --- | --- |\n' + Object.entries(routes).map(([key, r]) => `| ${key} | ${r.area} | ${r.path} |`).join('\n') + '\n';
function resources() { return new MemoryResources({ 'authority.json': JSON.stringify(makeCli()), 'paths.md': markdown, 'n_paths.json': JSON.stringify({ schema: 'nyx.paths.v1', resources: routes }), 'd_paths.json': JSON.stringify({ schema: 'nyx.paths.v1', resources: routes }), 'maps.md': '# Maps\nExact content\n', 'todo.md': '# Todo\n', 'voice-state.json': '{"state":"active"}', 'voice-config.json': '{}', 'ogn-state.json': '{}', 'ogn-config.json': '{}', 'normal.md': 'Normal', 'deep.md': 'Deep' }); }
function executor(r) { return new NyxCommandExecutor({ locate: async () => locator }, new NyxCliRegistryService(r), new NyxCommandResolver(), new NyxResourceResolver(r), handoffs(r), new NyxExecutionProfileService(r)); }

test('matches data-defined names and aliases, including case', () => { const resolver = new NyxCommandResolver(); assert.equal(resolver.resolve(makeCli(), { command: 'START' }).name, 'begin'); });
test('unknown command rejected', () => assert.throws(() => new NyxCommandResolver().resolve(makeCli(), { command: 'unlisted' }), /UNKNOWN_COMMAND/));
test('descriptive historical definitions do not invent an executable contract', () => assert.throws(() => new NyxCommandResolver().resolve(cliSchema.parse({ schema: 'historical', version: 'v1', commands: { ini: { purpose: 'initialize' } } }), { command: 'ini' }), /CONTRACT_MISSING/));
test('invalid input and disallowed depths or mutation rejected', () => { const cli = makeCli(); cli.commands.begin.execution.depth.allowed = ['basic']; assert.throws(() => new NyxCommandResolver().resolve(cli, { command: 'begin', depth: 'deep' }), /DEPTH_NOT_ALLOWED/); cli.commands.begin.execution.mutation = 'none'; assert.throws(() => new NyxCommandResolver().resolve(cli, { command: 'begin' }), /INIT_CONTRACT_UNSAFE/); assert.throws(() => new NyxCommandResolver().resolve(makeCli(), { command: 'begin', args: ['../escape'] })); });
test('hash cache stats every command and reloads changed CLI', async () => { const r = resources(); const registry = new NyxCliRegistryService(r); await registry.current(locator); await registry.current(locator); assert.equal(r.reads.length, 1); assert.equal(r.stats, 2); const changed = makeCli(); changed.version = 'test-v2'; r.files.set('authority.json', JSON.stringify(changed)); assert.equal((await registry.current(locator)).cli.version, 'test-v2'); });
test('invalid changed authority rejects instead of using stale cache', async () => { const r = resources(); const registry = new NyxCliRegistryService(r); await registry.current(locator); r.files.set('authority.json', 'not json'); await assert.rejects(() => registry.current(locator), /CLI_INVALID/); await assert.rejects(() => registry.current(locator), /CLI_INVALID/); });
test('ambiguous aliases reject whole CLI', async () => { const r = resources(); const cli = makeCli(); cli.commands.other = { aliases: ['start'] }; r.files.set('authority.json', JSON.stringify(cli)); await assert.rejects(() => new NyxCliRegistryService(r).current(locator), /CLI_INVALID/); });
test('hashless providers reread authority instead of trusting mtime', async () => { const r = resources(); r.stat = async () => ({ Size: 10, ModTime: 'unchanged' }); const registry = new NyxCliRegistryService(r); await registry.current(locator); await registry.current(locator); assert.equal(r.reads.length, 2); });
test('Basic reads no Normal/Deep registry and bare sources contain only Paths/Maps', async () => { const r = resources(); const out = await executor(r).execute({ command: 'begin', conversationId: 'chat-one' }); assert.deepEqual(out.files_to_paste.map(f => f.name), ['paths.md', 'maps.md']); assert.equal(out.files_to_paste[1].content, r.files.get('maps.md')); assert.equal(r.reads.includes('n_paths.json'), false); assert.equal(r.reads.includes('d_paths.json'), false); assert.equal(out.fif.verified, true); assert.equal(r.writes.length, 1); const fif = JSON.parse(r.files.get(out.fif.ref.path)); assert.equal(fif.message_count, 'UNKNOWN'); assert.equal(fif.source_refs.length, 2); assert.equal(JSON.stringify(fif).includes('Exact content'), false); });
test('Normal and Deep select only their own routed sources', async () => { for (const depth of ['normal', 'deep']) { const r = resources(); const out = await executor(r).execute({ command: 'begin', depth, conversationId: depth }); assert.equal(out.metadata.depth, depth); assert.deepEqual(out.files_to_paste.map(f => f.name), [depth === 'normal' ? 'n_paths.json' : 'd_paths.json', `${depth}.md`]); assert.equal(r.reads.includes(depth === 'normal' ? 'd_paths.json' : 'n_paths.json'), false); } });
test('multi-target init uses only selected target resources; oGN stays an argument', async () => { const r = resources(); const out = await executor(r).execute({ command: 'begin', args: ['Voice', 'oGN'], conversationId: 'targeted-chat' }); assert.deepEqual(out.metadata.targets, ['Voice', 'oGN']); assert.deepEqual(out.files_to_paste.map(f => f.name), ['paths.md', 'maps.md', 'todo.md', 'voice-state.json', 'ogn-state.json', 'voice-config.json', 'ogn-config.json']); });
test('missing mandatory target source fails before any artifact write', async () => { const r = resources(); r.files.delete('ogn-config.json'); await assert.rejects(() => executor(r).execute({ command: 'begin', args: ['oGN'], conversationId: 'chat' }), /REQUIRED_SOURCE/); assert.equal(r.writes.length, 0); });
test('optional source emits warning', async () => { const r = resources(); const cli = makeCli(); cli.commands.begin.execution.sources.basic.push({ key: 'missing', required: false, visible: false }); r.files.set('authority.json', JSON.stringify(cli)); const out = await executor(r).execute({ command: 'begin' }); assert.deepEqual(out.metadata.warnings, ['OPTIONAL_SOURCE_UNAVAILABLE:missing']); });
test('same conversation init idempotent; changed sources append immutable revision', async () => { const r = resources(); const e = executor(r); const a = await e.execute({ command: 'begin', conversationId: 'stable' }); const b = await e.execute({ command: 'begin', conversationId: 'stable' }); assert.equal(a.fif.id, b.fif.id); assert.equal(r.writes.length, 1); const original = r.files.get(a.fif.ref.path); r.files.set('maps.md', 'Changed maps'); const c = await e.execute({ command: 'begin', conversationId: 'stable' }); assert.equal(a.fif.id, c.fif.id); assert.notEqual(a.fif.ref.path, c.fif.ref.path); assert.equal(r.files.get(a.fif.ref.path), original); });
test('owner and conversation isolation; absent identity returned for reuse', async () => { assert.notEqual(artifactId('owner-a', 'chat'), artifactId('owner-b', 'chat')); const r = resources(); const e = executor(r); const a = await e.execute({ command: 'begin' }); assert.match(a.conversation_id, /^[a-f0-9-]{36}$/); const b = await e.execute({ command: 'begin', conversationId: a.conversation_id }); assert.equal(a.fif.id, b.fif.id); });
test('concurrent same-session retries serialize to a single artifact', async () => { const r = resources(); const e = executor(r); const [a,b] = await Promise.all([e.execute({ command: 'begin', conversationId: 'same' }), e.execute({ command: 'begin', conversationId: 'same' })]); assert.equal(a.fif.id, b.fif.id); assert.equal(r.writes.length, 1); });
test('real store requires durable locking, no in-memory production fallback', async () => { const h = new HandoffStore(resources()); await assert.rejects(() => h.initialize('owner', 'chat', ref('Handoffs'), {}), /DURABLE_HANDOFF_LOCK/); });
test('readback tampering blocks subsequent init', async () => { const r = resources(); const e = executor(r); const a = await e.execute({ command: 'begin', conversationId: 'tampered' }); r.files.set(a.fif.ref.path, '{}'); await assert.rejects(() => e.execute({ command: 'begin', conversationId: 'tampered' }), /CHECKPOINT_CHANGED/); });
test('FIF promotion preserves identity, verifies manifest last, appends repeated SUM revisions', async () => { const r = resources(); const h = handoffs(r); const metadata = { command: { name: 'begin', targets: [], depth: 'basic' }, canonical: locator.canonical, cli: { version: 'test', sha256: 'test' }, loaded_context: { areas: [], sources: [] }, source_refs: [] }; const initial = await h.initialize('owner', 'chat', ref('private/Handoffs'), metadata); const a = await h.promote('owner', 'chat', ref('private/Handoffs'), { markdown: 'Summary', data: { summary: 'Summary' } }); assert.equal(initial.id, a.id); assert.equal(a.kind, 'FIB'); assert.match(r.writes.at(-1), /manifest.json$/); const count = r.writes.length; await h.promote('owner', 'chat', ref('private/Handoffs'), { markdown: 'Summary', data: { summary: 'Summary' } }); assert.equal(r.writes.length, count); const b = await h.promote('owner', 'chat', ref('private/Handoffs'), { markdown: 'Next', data: {} }); assert.notEqual(b.ref.path, a.ref.path); assert.equal(r.files.has(initial.ref.path), true); const c = await h.initialize('owner', 'chat', ref('private/Handoffs'), { ...metadata, loaded_context: { areas: [], sources: ['extra'] } }); assert.equal(c.kind, 'FIB'); });
test('secret fields rejected in sources and promotion data', async () => { assert.throws(() => assertNoSecrets({ password: 'synthetic-sensitive-value' }), /SECRET_FIELD/); const r = resources(); r.files.set('maps.md', '{"access_token":"synthetic-sensitive-value"}'); await assert.rejects(() => executor(r).execute({ command: 'begin' }), /SECRET_FIELD/); assert.equal(r.writes.length, 0); });
test('Basic duplicate routes fail; ambiguous case-insensitive routes fail', async () => { const resolver = new NyxResourceResolver(resources()); assert.throws(() => resolver.markdownRoutes(markdown + '| MAPS | MAIN | wrong.md |\n'), /DUPLICATE/); });
test('compatibility wrapper forwards multiple targets and leaves depth default to CLI', async () => { let received; const init = new InitService({ execute: async (r) => { received = r; } }); await init.initialize({ target: 'Voice oGN' }); assert.deepEqual(received.args, ['Voice', 'oGN']); assert.equal(received.depth, undefined); });
test('bootstrap fails closed when locator unavailable', async () => { const saved = process.env.NYX_BOOTSTRAP_PATH; delete process.env.NYX_BOOTSTRAP_PATH; try { await assert.rejects(() => new NyxBootstrapService(resources()).locate(), /NOT_CONFIGURED/); } finally { if (saved) process.env.NYX_BOOTSTRAP_PATH = saved; } });
test('storage rejects traversal before provider invocation', async () => { const store = new NyxResourceStore({ resolve() { throw new Error('should not reach'); } }, {}); await assert.rejects(() => store.stat(ref('../escape')), /RESOURCE_STAT_FAILED/); });

test('remote FIF write before database checkpoint is recovered without overwriting evidence', async () => { const r = resources(); const h = handoffs(r); const metadata = { command: { name: 'begin', targets: [], depth: 'basic' }, canonical: locator.canonical, cli: { version: 'test', sha256: 'test' }, loaded_context: { areas: [], sources: [] }, source_refs: [] }; const a = await h.initialize('owner', 'recovery', ref('Handoffs'), metadata); const original = r.files.get(a.ref.path); const fresh = handoffs(r); const recovered = await fresh.initialize('owner', 'recovery', ref('Handoffs'), metadata); assert.equal(recovered.id, a.id); assert.equal(r.files.get(a.ref.path), original); });

test('ZIP CLI loads only exact matched member and verifies the container hash', async () => {
  const AdmZip = require('adm-zip'); const zip = new AdmZip(); zip.addFile('current/nyxcli.json', Buffer.from(JSON.stringify(makeCli()))); zip.addFile('unrelated.json', Buffer.from('{}')); const buffer = zip.toBuffer();
  const r = { stat: async () => ({ Size: buffer.length, Hashes: { sha256: sha256(buffer) } }), bytes: async () => buffer };
  const located = { ...locator, cli: { ...ref('head.zip'), member: 'current/nyxcli.json', sha256: sha256(buffer) } };
  assert.equal((await new NyxCliRegistryService(r).current(located)).cli.version, 'test-v1');
  await assert.rejects(() => new NyxCliRegistryService(r).current({ ...located, cli: { ...located.cli, sha256: '0'.repeat(64) } }), /CLI_INVALID/);
});
test('CLI bytes changed between stat and read never execute under an old hash receipt', async () => {
  const r = resources(); r.stat = async () => ({ Hashes: { sha256: '0'.repeat(64) }, Size: 10 });
  await assert.rejects(() => new NyxCliRegistryService(r).current(locator), /CLI_INVALID/);
});
test('production artifact adapter refuses clobber and verifies actual provider readback', async () => {
  const fs = require('node:fs/promises'); const data = new Map(); let corrupt = false;
  const rclone = { json: async ([op, target]) => { if (!data.has(target)) throw new Error('rclone exited 3: object not found'); return { Size: Buffer.byteLength(data.get(target)), IsDir: false }; }, run: async args => {
    if (args[0] === 'copyto') { assert.equal(args[3], '--immutable'); data.set(args[2], corrupt ? 'corrupted' : await fs.readFile(args[1], 'utf8')); return { stdout: '', stderr: '' }; }
    if (!data.has(args[1])) throw new Error('rclone exited 3: object not found');
    return { stdout: data.get(args[1]), stderr: '' };
  } };
  const store = new NyxResourceStore({ resolve: (area, path) => `fixture:${path}` }, rclone);
  const receipt = await store.createVerified(ref('Handoffs/test.json'), '{"safe":true}'); assert.equal(receipt.verified, true);
  await assert.rejects(() => store.createVerified(ref('Handoffs/test.json'), '{"different":true}'), /IMMUTABLE_ARTIFACT_CONFLICT/);
  corrupt = true; await assert.rejects(() => store.createVerified(ref('Handoffs/corrupt.json'), '{}'), /ARTIFACT_WRITE_VERIFY_FAILED/);
});
test('promoted FIB member tampering blocks further SUM promotion', async () => {
  const r = resources(); const h = handoffs(r); const metadata = { command: { name: 'begin', targets: [], depth: 'basic' }, canonical: locator.canonical, cli: { version: 'test', sha256: 'test' }, loaded_context: { areas: [], sources: [] }, source_refs: [] };
  await h.initialize('owner', 'fib-tamper', ref('Handoffs'), metadata);
  const cp = await h.promote('owner', 'fib-tamper', ref('Handoffs'), { markdown: 'A', data: {} }); const manifest = JSON.parse(r.files.get(cp.ref.path)); r.files.set(manifest.files[0].ref.path, '{}');
  await assert.rejects(() => h.promote('owner', 'fib-tamper', ref('Handoffs'), { markdown: 'B', data: {} }), /FIB_MEMBER_CHANGED/);
});


test('private profile is bound to current canonical CLI and cannot introduce commands', async () => {
 const r = resources(); const cli = makeCli(); const hash = sha256(JSON.stringify(cli)); const profile = { schema: 'nyx.runtime-profile.v1', authority: 'user-authorized-runtime-configuration', cliSha256: hash, commands: { begin: contract() } }; r.files.set('profile.json', JSON.stringify(profile)); const loc = { ...locator, executionProfile: ref('profile.json') }; const service = new NyxExecutionProfileService(r);
 assert.equal((await service.apply(loc, cli, hash)).cli.commands.begin.execution.depth.default, 'basic');
 await assert.rejects(() => service.apply(loc, cli, '0'.repeat(64)), /EXECUTION_PROFILE_INVALID/);
 profile.commands.unlisted = contract(); r.files.set('profile.json', JSON.stringify(profile)); await assert.rejects(() => service.apply(loc, cli, hash), /EXECUTION_PROFILE_INVALID/);
});
test('single-dyno remote ledger survives restart and serializes retries without a database', async () => {
 const oldMode = process.env.NYX_HANDOFF_COORDINATION, oldDyno = process.env.DYNO; process.env.NYX_HANDOFF_COORDINATION = 'single-dyno'; process.env.DYNO = 'web.1';
 try { const r = resources(); const h = new HandoffStore(r); const meta = { command: { name: 'begin', targets: [], depth: 'basic' }, canonical: locator.canonical, cli: { version: 'test', sha256: 'test' }, loaded_context: { areas: [], sources: [] }, source_refs: [] }; const [a,b] = await Promise.all([h.initialize('owner', 'remote', ref('Handoffs'), meta),h.initialize('owner', 'remote', ref('Handoffs'), meta)]); assert.equal(a.id,b.id); const restarted = new HandoffStore(r); assert.equal((await restarted.initialize('owner', 'remote', ref('Handoffs'), meta)).ref.path, a.ref.path); assert.equal(r.writes.length,2); process.env.DYNO = 'web.2'; await assert.rejects(() => restarted.initialize('owner', 'other', ref('Handoffs'), meta), /DURABLE_HANDOFF_LOCK/); }
 finally { if (oldMode === undefined) delete process.env.NYX_HANDOFF_COORDINATION; else process.env.NYX_HANDOFF_COORDINATION = oldMode; if (oldDyno === undefined) delete process.env.DYNO; else process.env.DYNO = oldDyno; }
});

test('single-dyno deployment gate rejects scaling, preboot and unknown topology', () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'nyx-topology-'));
  try {
    const formation = join(dir, 'formation.json'), features = join(dir, 'features.json');
    const run = (quantity, preboot) => {
      writeFileSync(formation, JSON.stringify([{ type: 'web', quantity }]));
      writeFileSync(features, JSON.stringify(preboot === undefined ? [] : [{ name: 'preboot', enabled: preboot }]));
      return spawnSync(process.execPath, ['scripts/verify-handoff-topology.mjs', formation, features], { encoding: 'utf8' }).status;
    };
    assert.equal(run(1, false), 0);
    assert.notEqual(run(2, false), 0);
    assert.notEqual(run(1, true), 0);
    assert.notEqual(run(1, undefined), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selected sources read with bounded concurrency and retain contract order', async () => {
  const r = resources(), read = r.read.bind(r); let active = 0, peak = 0;
  r.read = async ref => {
    if (['authority.json', 'paths.md'].includes(ref.path)) return read(ref);
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, ref.path.includes('voice') ? 15 : 2)); return await read(ref); }
    finally { active--; }
  };
  const out = await executor(r).execute({ command: 'begin', args: ['Voice', 'oGN'] });
  assert.ok(peak > 1 && peak <= 4);
  assert.deepEqual(out.files_to_paste.map(f => f.name), ['paths.md', 'maps.md', 'todo.md', 'voice-state.json', 'ogn-state.json', 'voice-config.json', 'ogn-config.json']);
});

test('bounded source reads reject oversized payloads and uncertain optional reads', async () => {
  const store = new NyxResourceStore({ resolve: (area, path) => path }, { run: async (args, limit) => { assert.equal(limit, 8); return { stdout: 'oversized-content', stderr: '' }; } });
  await assert.rejects(() => store.read(ref('source'), 8), /RESOURCE_READ_FAILED/);
  const denied = new NyxResourceStore({ resolve: (area, path) => path }, { run: async () => { throw new Error('rclone exited 5: access denied'); } });
  await assert.rejects(() => denied.optionalRead(ref('destination')), /RESOURCE_LOOKUP_FAILED/);
});

test('remote checkpoint reader preserves previously deployed nested lineage', async () => {
  const saved = [process.env.NYX_HANDOFF_COORDINATION, process.env.DYNO];
  process.env.NYX_HANDOFF_COORDINATION = 'single-dyno'; process.env.DYNO = 'web.1';
  try {
    const r = resources(), h = new HandoffStore(r);
    const meta = { command: { name: 'begin', targets: [], depth: 'basic' }, canonical: locator.canonical, cli: { version: 'test', sha256: 'test' }, loaded_context: { areas: [], sources: [] }, source_refs: [] };
    const a = await h.initialize('owner', 'legacy', ref('Handoffs'), meta);
    const flat = `Handoffs/runtime_lineage/${a.id}.0000000001.json`, nested = `Handoffs/runtime_lineage/${a.id}/0000000001.json`;
    r.files.set(nested, r.files.get(flat)); r.files.delete(flat);
    const restarted = new HandoffStore(r);
    assert.equal((await restarted.initialize('owner', 'legacy', ref('Handoffs'), meta)).sha256, a.sha256);
    assert.equal(r.files.has(nested), true); assert.equal(r.files.has(flat), false);
  } finally { saved.forEach((value, i) => { const key = ['NYX_HANDOFF_COORDINATION', 'DYNO'][i]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});
