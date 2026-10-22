const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { cliSchema } = require('../dist/nyx/runtime.schema');
const { NyxCommandResolver } = require('../dist/nyx/command-resolver');

const makeCli = () => cliSchema.parse({
  schema: 'nyx.yarocli.v1',
  version: 'v007',
  commands: {
    ini: {
      typed_resource_resolution: {
        collisions: [
          'FileFilter core_skill/area',
          'Mental domain/area',
          'Voice core_skill/area',
        ],
      },
      execution: {
        adapter: 'context.initialize.v1',
        depth: { default: 'normal', allowed: ['basic', 'normal', 'deep'] },
        scope: {
          default: 'local',
          localAreas: ['MAIN'],
          externalContext: [],
          globalLabel: 'all_configured_nyx_drives',
        },
        arguments: { targets: true, maxTargets: 16 },
        sources: { basic: [], normal: [], deep: [] },
        pathsVisible: true,
        mutation: 'conversation-artifact',
        handoffsKey: 'handoffs',
        verification: { sourceRead: true, artifactReadback: true },
        response: 'nyx.context.v1',
      },
    },
  },
});

test('H31 collision names cannot silently initialize as a bare Area', () => {
  const resolver = new NyxCommandResolver();
  const cli = makeCli();
  for (const target of ['Voice', 'FileFilter', 'Mental']) {
    assert.throws(
      () => resolver.resolve(cli, { command: 'ini', args: [target, 'oGN'] }),
      /AMBIGUOUS_TYPED_RESOURCE/,
      target,
    );
  }
});

test('typed names are accepted as syntax, then blocked until typed receipt execution exists', () => {
  const resolver = new NyxCommandResolver();
  const cli = makeCli();
  for (const target of ['area:Voice', 'core_skill:Voice', 'area:NoteFlow']) {
    assert.throws(
      () => resolver.resolve(cli, { command: 'ini', args: [target, 'oGN'] }),
      /TYPED_RESOURCE_ADAPTER_NOT_READY/,
      target,
    );
  }
});

test('unique legacy targets still resolve, with global normal modifier', () => {
  const resolved = new NyxCommandResolver().resolve(makeCli(), {
    command: 'ini',
    args: ['NoteFlow', 'oGN'],
  });
  assert.deepEqual(
    { targets: resolved.targets, scope: resolved.scope, depth: resolved.depth },
    { targets: ['NoteFlow'], scope: 'global', depth: 'normal' },
  );
});
