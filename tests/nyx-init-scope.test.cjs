const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { cliSchema } = require('../dist/nyx/runtime.schema');
const { NyxCommandResolver } = require('../dist/nyx/command-resolver');
const { NyxCliRegistryService } = require('../dist/nyx/cli-registry.service');
const { NyxResourceResolver } = require('../dist/nyx/resource-resolver.service');
const { NyxCommandExecutor } = require('../dist/nyx/command-executor.service');
const { HandoffStore } = require('../dist/nyx/handoff-store.service');
const { NyxExecutionProfileService } = require('../dist/nyx/execution-profile.service');
const { sha256 } = require('../dist/nyx/resource-store.service');

const ref = path => ({ area: 'MAIN', path });
const source = (key, when = 'always') => ({ key, required: true, visible: true, when, perTarget: false });
const contract = () => ({
  adapter: 'context.initialize.v1',
  depth: { default: 'normal', allowed: ['basic', 'normal', 'deep'] },
  scope: { default: 'local', localAreas: ['MAIN'], externalContext: ['chatgpt_library'], globalLabel: 'all_configured_nyx_drives' },
  arguments: { targets: true, maxTargets: 16 },
  sources: {
    basic: [source('maps'), source('nyxcli'), source('todo', 'targeted'), source('todo_10', 'targeted'), source('toget', 'targeted')],
    normal: [source('maps'), source('nyxcli'), source('todo', 'targeted'), source('todo_10', 'targeted'), source('toget', 'targeted')],
    deep: [source('maps'), source('nyxcli'), source('todo', 'targeted'), source('todo_10', 'targeted'), source('toget', 'targeted')],
  },
  pathsVisible: true,
  mutation: 'conversation-artifact',
  handoffsKey: 'handoffs',
  verification: { sourceRead: true, artifactReadback: true },
  response: 'nyx.context.v1',
});
const makeCli = () => cliSchema.parse({ schema: 'nyx.yarocli.v1', version: 'test-v1', commands: { ini: { execution: contract() } } });
const locator = {
  schema: 'nyx.bootstrap.v1',
  cli: ref('authority.json'),
  humanCli: ref('nyxcli.md'),
  paths: { basic: ref('paths.md'), normal: ref('n_paths.json'), deep: ref('d_paths.json') },
  canonical: { head: 'head.zip', body: 'body.zip', footer: 'footer.zip' },
};
const routes = { maps: ref('maps.md'), todo: ref('todo.md'), todo_10: ref('todo_10.md'), toget: ref('toget.md'), handoffs: ref('Handoffs') };
const markdown = '# Nyx Paths\n\n| key | area | path |\n| --- | --- | --- |\n' + Object.entries(routes).map(([key, r]) => `| ${key} | ${r.area} | ${r.path} |`).join('\n') + '\n';

class MemoryResources {
  constructor() {
    this.files = new Map(Object.entries({
      'authority.json': JSON.stringify(makeCli()),
      'paths.md': markdown,
      'n_paths.json': JSON.stringify({ schema: 'nyx.filefilter_paths.normal.v1', depth: 'oN' }),
      'd_paths.json': JSON.stringify({ schema: 'nyx.filefilter_paths.deep.v1', depth: 'oD' }),
      'nyxcli.md': '# Nyx CLI\n',
      'maps.md': '# Maps\n',
      'todo.md': '# Todo\n',
      'todo_10.md': '# Todo 10\n',
      'toget.md': '# ToGet\n',
    }));
    this.reads = []; this.writes = []; this.stats = 0;
  }
  async stat(r) { this.stats++; const data = this.files.get(r.path); if (data === undefined) throw new Error('RESOURCE_STAT_FAILED'); return { Size: Buffer.byteLength(data), Hashes: { sha256: sha256(data) } }; }
  async read(r) { this.reads.push(r.path); if (!this.files.has(r.path)) throw new Error('RESOURCE_READ_FAILED'); return this.files.get(r.path); }
  async optionalRead(r) { return this.files.get(r.path); }
  async optionalList(r) { const out = new Map(); for (const p of this.files.keys()) if (p.startsWith(r.path + '/')) { const tail = p.slice(r.path.length + 1), Name = tail.split('/')[0]; out.set(Name, { Name, IsDir: tail.includes('/') }); } return [...out.values()]; }
  async createVerified(r, text) { const old = this.files.get(r.path); if (old !== undefined && old !== text) throw new Error('IMMUTABLE_ARTIFACT_CONFLICT'); this.files.set(r.path, text); this.writes.push(r.path); return { sha256: sha256(text), verified: true }; }
}
function handoffs(resources) {
  const h = new HandoffStore(resources); const state = new Map(); let tail = Promise.resolve();
  h.locked = (id, action) => { const next = tail.then(() => action(state.get(id), async value => { state.set(id, value); })); tail = next.catch(() => {}); return next; };
  return h;
}
function executor(resources) {
  return new NyxCommandExecutor(
    { locate: async () => locator },
    new NyxCliRegistryService(resources),
    new NyxCommandResolver(),
    new NyxResourceResolver(resources),
    handoffs(resources),
    new NyxExecutionProfileService(resources),
  );
}

test('scoped ini defaults to oLN and treats modifiers as configuration, not targets', () => {
  const resolver = new NyxCommandResolver(); const cli = makeCli();
  const a = resolver.resolve(cli, { command: 'ini', args: ['Voice'] });
  assert.deepEqual({ targets: a.targets, scope: a.scope, depth: a.depth, modifier: a.modifier }, { targets: ['Voice'], scope: 'local', depth: 'normal', modifier: 'oLN' });
  const b = resolver.resolve(cli, { command: 'ini', args: ['Voice', 'OGN'] });
  assert.deepEqual({ targets: b.targets, scope: b.scope, depth: b.depth, modifier: b.modifier }, { targets: ['Voice'], scope: 'global', depth: 'normal', modifier: 'oGN' });
  assert.throws(() => resolver.resolve(cli, { command: 'ini', args: ['oGN'] }), /MODIFIER_REQUIRES_TARGET/);
});

test('scope upgrade and downgrade require an existing conversation identity', () => {
  const resolver = new NyxCommandResolver(); const cli = makeCli();
  assert.throws(() => resolver.resolve(cli, { command: 'ini', args: ['++'] }), /CONVERSATION_ID_REQUIRED/);
  assert.equal(resolver.resolve(cli, { command: 'ini', args: ['++'], conversationId: 'chat' }).scopeAction, 'upgrade');
  assert.equal(resolver.resolve(cli, { command: 'ini', args: ['--'], conversationId: 'chat' }).scopeAction, 'downgrade');
});

test('bare and Voice init return the agreed compact packet and store oLN in FIF', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const bare = await e.execute({ command: 'ini', conversationId: 'bare' });
  assert.deepEqual(bare.files_to_paste.map(x => x.name), ['paths.md', 'maps.md', 'nyxcli.md']);
  assert.equal(bare.metadata.modifier, 'oLN');
  assert.equal(bare.metadata.scope, 'local');
  assert.ok(r.reads.includes('n_paths.json'));
  const bareFif = JSON.parse(r.files.get(bare.fif.ref.path));
  assert.equal(bareFif.chat_config.initial.modifier, 'oLN');
  assert.equal(bareFif.chat_config.current.modifier, 'oLN');
  assert.deepEqual(bareFif.chat_config.current.access.backend_areas, ['MAIN']);
  assert.deepEqual(bareFif.chat_config.current.access.external_context, ['chatgpt_library']);

  const voice = await e.execute({ command: 'ini', args: ['Voice'], conversationId: 'voice' });
  assert.deepEqual(voice.files_to_paste.map(x => x.name), ['paths.md', 'maps.md', 'nyxcli.md', 'todo.md', 'todo_10.md', 'toget.md']);
  assert.equal(voice.files_to_paste.some(x => /todo_30|state|config/i.test(x.name)), false);
});

test('Voice oGN is valid global Normal and standalone oGN is rejected', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const out = await e.execute({ command: 'ini', args: ['Voice', 'oGN'], conversationId: 'global' });
  assert.deepEqual(out.metadata.targets, ['Voice']);
  assert.equal(out.metadata.modifier, 'oGN');
  assert.equal(out.metadata.scope, 'global');
  const fif = JSON.parse(r.files.get(out.fif.ref.path));
  assert.equal(fif.chat_config.current.access.backend_areas, 'all_configured_nyx_drives');
  await assert.rejects(() => e.execute({ command: 'ini', args: ['oGN'], conversationId: 'bad' }), /MODIFIER_REQUIRES_TARGET/);
});

test('++ and -- keep FIF identity, preserve depth and append scope history', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const first = await e.execute({ command: 'ini', args: ['Voice'], conversationId: 'same-chat' });
  const up = await e.execute({ command: 'ini', args: ['++'], conversationId: first.conversation_id });
  assert.equal(up.fif.id, first.fif.id); assert.equal(up.metadata.modifier, 'oGN'); assert.equal(up.metadata.depth, 'normal'); assert.equal(up.files_to_paste.length, 0);
  let fif = JSON.parse(r.files.get(up.fif.ref.path));
  assert.equal(fif.chat_config.initial.modifier, 'oLN'); assert.equal(fif.chat_config.current.modifier, 'oGN'); assert.equal(fif.chat_config.history.at(-1).operation, '++');
  const down = await e.execute({ command: 'ini', args: ['--'], conversationId: first.conversation_id });
  assert.equal(down.fif.id, first.fif.id); assert.equal(down.metadata.modifier, 'oLN');
  fif = JSON.parse(r.files.get(down.fif.ref.path));
  assert.deepEqual(fif.chat_config.history.map(x => x.operation), ['++', '--']);
});
