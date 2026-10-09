const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const AdmZip = require('adm-zip');
const { cliSchema } = require('../dist/nyx/runtime.schema');
const { NyxCommandResolver } = require('../dist/nyx/command-resolver');
const { NyxCliRegistryService } = require('../dist/nyx/cli-registry.service');
const { NyxResourceResolver } = require('../dist/nyx/resource-resolver.service');
const { NyxCommandExecutor } = require('../dist/nyx/command-executor.service');
const { HandoffStore } = require('../dist/nyx/handoff-store.service');
const { NyxExecutionProfileService } = require('../dist/nyx/execution-profile.service');
const { NyxHeadLibraryService } = require('../dist/nyx/head-library.service');
const { sha256 } = require('../dist/nyx/resource-store.service');

const ref = path => ({ area: 'MAIN', path });
const source = (key, when = 'always') => ({ key, required: true, visible: true, when, perTarget: false });
const iniContract = () => ({
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
const sumContract = () => ({
  adapter: 'context.summarize.v1',
  depth: { default: 'normal', allowed: ['normal'] },
  arguments: { targets: false, maxTargets: 0 },
  sources: { basic: [], normal: [], deep: [] },
  pathsVisible: false,
  mutation: 'conversation-artifact',
  handoffsKey: 'handoffs',
  verification: { sourceRead: true, artifactReadback: true },
  response: 'nyx.context.v1',
});
const makeCli = () => cliSchema.parse({
  schema: 'nyx.yarocli.v1',
  version: 'test-v1',
  commands: { ini: { execution: iniContract() }, sum: { execution: sumContract() } },
});
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
  async stat(r) {
    this.stats++;
    const data = this.files.get(r.path);
    if (data === undefined) throw new Error('RESOURCE_STAT_FAILED');
    return { Size: Buffer.byteLength(data), Hashes: { sha256: sha256(data) } };
  }
  async read(r) {
    this.reads.push(r.path);
    if (!this.files.has(r.path)) throw new Error('RESOURCE_READ_FAILED');
    return this.files.get(r.path);
  }
  async optionalRead(r) { return this.files.get(r.path); }
  async optionalList(r) {
    const out = new Map();
    for (const p of this.files.keys()) if (p.startsWith(r.path + '/')) {
      const tail = p.slice(r.path.length + 1), Name = tail.split('/')[0];
      out.set(Name, { Name, IsDir: tail.includes('/') });
    }
    return [...out.values()];
  }
  async createVerified(r, text) {
    const old = this.files.get(r.path);
    if (old !== undefined && old !== text) throw new Error('IMMUTABLE_ARTIFACT_CONFLICT');
    this.files.set(r.path, text); this.writes.push(r.path);
    return { sha256: sha256(text), verified: true };
  }
}
function handoffs(resources) {
  const h = new HandoffStore(resources); const state = new Map(); let tail = Promise.resolve();
  h.locked = (id, action) => {
    const next = tail.then(() => action(state.get(id), async value => { state.set(id, value); }));
    tail = next.catch(() => {}); return next;
  };
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

test('SUM requires an initialized conversation and typed payload', async () => {
  const r = new MemoryResources(); const e = executor(r);
  await assert.rejects(() => e.execute({ command: 'sum', conversationId: 'missing', payload: { title: 'T', summary: 'S' } }), /FIF_NOT_INITIALIZED/);
  assert.throws(() => new NyxCommandResolver().resolve(makeCli(), { command: 'sum', conversationId: 'chat' }), /SUM_PAYLOAD_REQUIRED/);
  assert.throws(() => new NyxCommandResolver().resolve(makeCli(), { command: 'sum', payload: { title: 'T', summary: 'S' } }), /CONVERSATION_ID_REQUIRED/);
});

test('SUM mutates continuity and promotes FIF to FIB under the same identity', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const initial = await e.execute({ command: 'ini', args: ['Voice'], conversationId: 'chat-sum' });
  const summed = await e.execute({
    command: 'sum',
    conversationId: initial.conversation_id,
    payload: {
      title: 'Voice continuity',
      summary: 'Implemented init scope and prepared next work.',
      messageCount: 12,
      compactContext: 'Voice chat continuity checkpoint.',
      urgentItems: ['Finish TechLab routing'],
      nextAction: 'Work on NoteFlow.',
    },
  });
  assert.equal(summed.fif.id, initial.fif.id);
  assert.equal(summed.fif.kind, 'FIB');
  assert.equal(summed.summary.title, 'Voice continuity');
  assert.equal(summed.summary.message_count, 12);
  const manifest = JSON.parse(r.files.get(summed.fif.ref.path));
  const fifEntry = manifest.files.find(x => x.ref.path.endsWith('/fif.json'));
  const summaryEntry = manifest.files.find(x => x.ref.path.endsWith('/summary.md'));
  const fif = JSON.parse(r.files.get(fifEntry.ref.path));
  assert.equal(fif.message_count, 12);
  assert.equal(fif.compact_context, 'Voice chat continuity checkpoint.');
  assert.deepEqual(fif.urgent_items, ['Finish TechLab routing']);
  assert.equal(fif.next_action, 'Work on NoteFlow.');
  assert.equal(fif.chat_config.current.modifier, 'oLN');
  assert.match(r.files.get(summaryEntry.ref.path), /^# Voice continuity/);
});

test('identical SUM is idempotent; changed SUM appends a new FIB revision', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const initial = await e.execute({ command: 'ini', conversationId: 'chat-repeat' });
  const payload = { title: 'Checkpoint', summary: 'Same data.', messageCount: 5 };
  const a = await e.execute({ command: 'sum', conversationId: initial.conversation_id, payload });
  const writes = r.writes.length;
  const b = await e.execute({ command: 'sum', conversationId: initial.conversation_id, payload });
  assert.equal(b.fif.ref.path, a.fif.ref.path);
  assert.equal(r.writes.length, writes);
  const c = await e.execute({ command: 'sum', conversationId: initial.conversation_id, payload: { ...payload, messageCount: 6, summary: 'New data.' } });
  assert.equal(c.fif.id, a.fif.id);
  assert.notEqual(c.fif.ref.path, a.fif.ref.path);
});

test('scope ++ and -- after SUM preserve FIB shape and summary while changing current scope', async () => {
  const r = new MemoryResources(); const e = executor(r);
  const initial = await e.execute({ command: 'ini', args: ['Voice'], conversationId: 'chat-config-after-sum' });
  const summed = await e.execute({ command: 'sum', conversationId: initial.conversation_id, payload: { title: 'Checkpoint', summary: 'Keep me.', messageCount: 8 } });
  const up = await e.execute({ command: 'ini', args: ['++'], conversationId: initial.conversation_id });
  assert.equal(up.fif.id, summed.fif.id);
  assert.equal(up.fif.kind, 'FIB');
  assert.equal(up.metadata.modifier, 'oGN');
  const upManifest = JSON.parse(r.files.get(up.fif.ref.path));
  const upSummary = upManifest.files.find(x => x.ref.path.endsWith('/summary.md'));
  assert.match(r.files.get(upSummary.ref.path), /Keep me/);
  const down = await e.execute({ command: 'ini', args: ['--'], conversationId: initial.conversation_id });
  assert.equal(down.fif.kind, 'FIB');
  assert.equal(down.metadata.modifier, 'oLN');
});

test('Head library verifies and reuses a canonical ZIP container', async () => {
  const zip = new AdmZip();
  zip.addFile('head/nyxcli.json', Buffer.from(JSON.stringify(makeCli())));
  const bytes = zip.toBuffer();
  let byteReads = 0;
  const store = {
    bytes: async () => { byteReads++; return bytes; },
  };
  const lib = new NyxHeadLibraryService(store);
  const headRef = { area: 'MAIN', path: 'head.zip', member: 'head/nyxcli.json', sha256: sha256(bytes) };
  const a = await lib.readMember(headRef, 'fingerprint', { sha256: sha256(bytes) });
  const b = await lib.readMember(headRef, 'fingerprint', { sha256: sha256(bytes) });
  assert.equal(JSON.parse(a.text).version, 'test-v1');
  assert.equal(b.library.source, 'canonical-head');
  assert.equal(byteReads, 1);
  assert.equal(lib.snapshot().loaded, true);
});
