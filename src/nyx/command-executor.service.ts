import { Injectable } from '@nestjs/common';
import { NyxExecutionProfileService } from './execution-profile.service';
import { CommandRequest } from './runtime.schema';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';
import { NyxCommandResolver } from './command-resolver';
import { NyxResourceResolver } from './resource-resolver.service';
import { ChatConfigState, HandoffStore, assertNoSecrets } from './handoff-store.service';

@Injectable()
export class NyxCommandExecutor {
  constructor(private readonly bootstrap: NyxBootstrapService, private readonly registry: NyxCliRegistryService, private readonly resolver: NyxCommandResolver, private readonly resources: NyxResourceResolver, private readonly handoffs: HandoffStore, private readonly profiles: NyxExecutionProfileService) {}
  async execute(request: CommandRequest, owner = 'api-key') {
    const locator = await this.bootstrap.locate();
    const { cli, hash } = await this.registry.current(locator);
    const profile = await this.profiles.apply(locator, cli, hash);
    const plan = this.resolver.resolve(profile.cli, request);

    if (plan.contract.adapter === 'context.help.v1') {
      // Head/YaRoCLI is authoritative; this is only a read-only presentation.
      const definitions=profile.cli.commands;
      // Keep the canonical Head order; don't lose new commands omitted from
      // a legacy command_order list. Runtime bindings only annotate availability.
      const ordered=(Array.isArray(profile.cli.canonical_command_order)
        ? profile.cli.canonical_command_order : []) as unknown[];
      const order=[
        ...ordered.filter((name):name is string=>
          typeof name==='string' && Object.prototype.hasOwnProperty.call(definitions,name)),
        ...Object.keys(definitions).filter(name=>!ordered.includes(name)),
      ];
      const commands=order.map(name=>{
        const definition=definitions[name];
        const detail=definition as Record<string,unknown>;
        const aliases=definition.aliases??[];
        const extras:Record<string,unknown>={};
        // All values are from the verified canonical Head and trimmed for
        // the help response; never infer command support from descriptions.
        for(const field of ['syntax','dependency','payload','depth_options',
          'command_local_stage_options','includes_sum','bundle_output']){
          const value=detail[field];
          if(typeof value==='string')extras[field]=value.slice(0,1400);
          else if(typeof value==='boolean')extras[field]=value;
          else if(value && typeof value==='object' && JSON.stringify(value).length<=2000)
            extras[field]=value;
        }
        return {
          name,
          canonicalSyntax:'Nyx'+name,
          syntax:'nyx '+name,
          aliases,
          purpose:typeof definition.purpose==='string'
            ?definition.purpose.slice(0,1800):'Purpose not defined',
          details:extras,
          executable:Boolean(definition.execution),
          status:definition.execution?'runtime-contract-available':'canonical-only',
        };
      });
      const markdown=[
        '# Nyx CLI — canonical command reference',
        '',
        'Generated from verified Head/LEAD/Core_Skills/YaRoCLI/nyxcli.json (read-only).',
        'The separate nyxcli.md is a compact human mirror and may not list every command.',
        '',
        ...commands.map(command=>
          '- `'+command.syntax+'` — '+command.purpose+
          (command.executable?' [backend contract available]':' [Head only; no backend contract]')),
      ].join('\n');
      const rules = profile.cli.scope_rules;
      const rule = (field: string) => {
        if (!rules || typeof rules !== 'object') return undefined;
        const value = (rules as Record<string, unknown>)[field];
        return typeof value === 'string' ? value.slice(0, 1200) : undefined;
      };
      return {
        schema: plan.contract.response,
        status: 'COMPLETE',
        canonical_command: 'hel',
        syntax: {canonical:'Nyxhel',spaced:'nyx hel',label:'Help'},
        command_count: commands.length,
        commands,
        markdown,
        human_mirror:{
          filename:typeof (profile.cli.human_mirror as {filename?:unknown}|undefined)?.filename==='string'
            ?(profile.cli.human_mirror as {filename:string}).filename:'nyxcli.md',
          relationship:'compact-human-mirror-not-command-authority',
          completeness:'not-guaranteed',
          verified_against_live_mirror:false,
        },
        scope_rules: {
          default: rule('default'),
          chain: rule('chain_scope_rule'),
          local_option: 'o<modifiers> (command-local, when supported)',
          inherited_option: '<modifiers>o (chain-inherited, when supported)',
        },
        notes: [
          'Command presence in Head does not imply backend execution support.',
          'Global scope does not grant access to otherwise unauthorized sources.',
          'Help is read-only and does not create or change handoffs, seeds, or core bundles.',
        ],
        metadata: {
          command: plan.name,
          cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash },
          canonical: locator.canonical,
          source: 'verified-current-head-cli',
          mutation: 'none',
        },
      };
    }

    if (plan.contract.adapter === 'context.summarize.v1') {
      const handoffRef = await this.resources.resolveHandoffs(locator, plan);
      const fib = await this.handoffs.summarize(owner, plan.conversationId!, handoffRef, plan.payload!);
      return {
        schema: plan.contract.response,
        status: 'COMPLETE',
        conversation_id: fib.conversationId,
        fif: { id: fib.id, kind: fib.kind, ref: fib.ref, sha256: fib.sha256, verified: fib.verified },
        files_to_paste: [],
        summary: {
          title: plan.payload!.title,
          body: plan.payload!.summary,
          message_count: fib.fif.message_count,
          urgent_items: fib.fif.urgent_items ?? [],
          next_action: fib.fif.next_action,
        },
        metadata: {
          command: plan.name,
          targets: [],
          depth: fib.fif.chat_config?.current.depth ?? plan.depth,
          scope: fib.fif.chat_config?.current.scope,
          modifier: fib.fif.chat_config?.current.modifier,
          cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash },
          source_receipts: [], key_preflight: profile.keyReceipts ?? [],
          warnings: [],
          upgraded: true,
          artifact_kind: fib.kind,
        },
      };
    }

    if (plan.scopeAction) {
      const handoffs = await this.resources.resolveHandoffs(locator, plan);
      const changed = await this.handoffs.reconfigure(owner, plan.conversationId!, handoffs, plan.scopeAction);
      return {
        schema: plan.contract.response,
        status: 'COMPLETE',
        conversation_id: changed.conversationId,
        fif: { id: changed.id, kind: changed.kind, ref: changed.ref, sha256: changed.sha256, verified: changed.verified },
        files_to_paste: [],
        metadata: {
          command: plan.name,
          targets: [],
          depth: changed.fif.chat_config?.current.depth,
          scope: changed.fif.chat_config?.current.scope,
          modifier: changed.fif.chat_config?.current.modifier,
          modifier_source: 'operation',
          scope_change: { operation: plan.scopeAction === 'upgrade' ? '++' : '--', changed: changed.changed, from: changed.from, to: changed.to },
          cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash },
          source_receipts: [], key_preflight: profile.keyReceipts ?? [], warnings: [],
        },
      };
    }

    const loaded = await this.resources.load(locator, plan);
    for (const file of loaded.files) assertNoSecrets(file.content);
    const chatState = this.chatState(plan);
    const fif = plan.contract.adapter === 'context.initialize.v1' ? await this.handoffs.initialize(owner, plan.conversationId, loaded.handoffs!, {
      command: { name: plan.name, targets: plan.targets, depth: plan.depth }, canonical: locator.canonical,
      cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash },
      loaded_context: { areas: plan.targets, sources: loaded.files.map(f => f.key) },
      source_refs: loaded.files.map(f => ({ key: f.key, ref: f.ref, sha256: f.sha256, bytes: f.bytes, returned: f.visible })),
      ...(chatState ? { chat_config: { initial: chatState, current: chatState, history: [] } } : {}),
    }) : undefined;
    return {
      schema: plan.contract.response, status: 'COMPLETE', conversation_id: fif?.conversationId,
      fif: fif ? { id: fif.id, kind: fif.kind, ref: fif.ref, sha256: fif.sha256, verified: fif.verified } : null,
      files_to_paste: loaded.files.filter(f => f.visible).map(f => ({ name: f.ref.path.split('/').pop(), key: f.key, content: f.content, ref: f.ref, sha256: f.sha256 })),
      metadata: {
        command: plan.name, targets: plan.targets, depth: plan.depth,
        ...(plan.scope ? { scope: plan.scope, modifier: plan.modifier, modifier_source: plan.modifierSource } : {}),
        cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash }, source_receipts: loaded.files.map(({ content, ...receipt }) => receipt), key_preflight: profile.keyReceipts ?? [], warnings: loaded.warnings,
      },
    };
  }

  private chatState(plan: ReturnType<NyxCommandResolver['resolve']>): ChatConfigState | undefined {
    if (!plan.contract.scope || !plan.scope || !plan.modifier) return undefined;
    const config = plan.contract.scope;
    return {
      modifier: plan.modifier,
      scope: plan.scope,
      depth: plan.depth,
      access: {
        backend_areas: plan.scope === 'local' ? [...config.localAreas] : config.globalLabel,
        external_context: [...config.externalContext],
      },
      source: (plan.modifierSource ?? 'default') as ChatConfigState['source'],
    };
  }
}
