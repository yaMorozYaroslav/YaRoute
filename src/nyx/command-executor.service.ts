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
          source_receipts: [],
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
          source_receipts: [], warnings: [],
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
        cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash }, source_receipts: loaded.files.map(({ content, ...receipt }) => receipt), warnings: loaded.warnings,
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
