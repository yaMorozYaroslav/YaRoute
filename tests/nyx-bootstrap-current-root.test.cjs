const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('reflect-metadata');

const { NyxBootstrapService } = require('../dist/nyx/bootstrap.service');
const { profileSchema } = require('../dist/nyx/runtime.schema');

const baseLocator = {
  schema: 'nyx.bootstrap.v1',
  cli: {
    area: 'MAIN',
    path: 'YaRoute/0_repository/0_head/head_db_v031.zip',
    member: 'head_db_v031/LEAD/Core_Skills/YaRoCLI/nyxcli.json',
    sha256: 'e857f66037cdae2ee998f714770ce94ee77caebeddcb0bf1ea13fc944a191007',
  },
  humanCli: {
    area: 'MAIN',
    path: 'YaRoute/1_depository/3_subfooter/2_areas_v0/FileFilter/0_state/nyxcli.md',
  },
  paths: {
    basic: {
      area: 'MAIN',
      path: 'YaRoute/1_depository/3_subfooter/2_areas_v0/FileFilter/0_state/paths.md',
    },
  },
  canonical: {
    head: 'head_db_v031.zip',
    body: 'body_db_v027.zip',
    footer: 'footer_db_v097.zip',
  },
};

class MemoryStore {
  constructor(locator) { this.locator = locator; }
  async read(ref) {
    if (ref.path !== 'Documents/Nyxpad/nyx_bootstrap.json') throw new Error('unexpected read');
    return JSON.stringify(this.locator);
  }
}

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
}

test('bootstrap keeps current undecorated YaRoute fallback paths', async () => {
  await withEnv({
    NYX_BOOTSTRAP_PATH: 'Documents/Nyxpad/nyx_bootstrap.json',
    NYX_INIT_AREA: 'MAIN',
    NYX_NORMAL_PATHS_PATH: 'YaRoute/current/n_paths.json',
    NYX_DEEP_PATHS_PATH: 'YaRoute/current/d_paths.json',
  }, async () => {
    const located = await new NyxBootstrapService(new MemoryStore(baseLocator)).locate();
    assert.equal(located.cli.path, baseLocator.cli.path);
    assert.equal(located.paths.normal.path, 'YaRoute/current/n_paths.json');
    assert.equal(located.paths.deep.path, 'YaRoute/current/d_paths.json');
  });
});

test('bootstrap normalizes only legacy decorated YaRoute fallback paths', async () => {
  await withEnv({
    NYX_BOOTSTRAP_PATH: 'Documents/Nyxpad/nyx_bootstrap.json',
    NYX_INIT_AREA: 'MAIN',
    NYX_NORMAL_PATHS_PATH: '🪼👁️📡YaRoute/current/n_paths.json',
  }, async () => {
    const located = await new NyxBootstrapService(new MemoryStore(baseLocator)).locate();
    assert.equal(located.paths.normal.path, 'YaRoute/current/n_paths.json');
    assert.equal(located.paths.deep.path, 'YaRoute/current/d_paths.json');
  });
});

test('deployed runtime profile is bound to H31 and current readable mirrors', () => {
  const raw = JSON.parse(fs.readFileSync('config/nyx-runtime-profile.json', 'utf8'));
  const profile = profileSchema.parse(raw);
  assert.equal(profile.cliSha256, '090f31ab61ce4228148cb9b551299667072c8ce9c3151bab3c48ab81b7112a4f');
  const byKey = Object.fromEntries(profile.keySources.map(source => [source.key, source]));
  assert.equal(byKey.temp_paths.ref.path, 'YaRoute/0_repository/3_template/staging/drafts/temp_paths.json');
  assert.equal(byKey.temp_nyxcli.ref.path, 'YaRoute/0_repository/3_template/staging/drafts/temp_nyxcli.json');
  assert.equal(byKey.active_key.ref.path, 'YaRoute/1_depository/3_subfooter/2_areas_v0/FileFilter/0_state/active_key.txt');
  assert.equal(byKey.active_key.mode, 'enforce');
  assert.equal(byKey.active_key.sha256, '595aa1204e1ae772cd66998e949d7b6c7b9a2df7b782782a6cc8f17c0cbbb1be');
});
