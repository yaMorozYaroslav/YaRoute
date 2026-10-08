import { Injectable } from '@nestjs/common';
import { NyxExecutionProfileService } from './execution-profile.service';
import { CommandRequest } from './runtime.schema';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';
import { NyxCommandResolver } from './command-resolver';
import { NyxResourceResolver } from './resource-resolver.service';
import { HandoffStore, assertNoSecrets } from './handoff-store.service';
@Injectable()
export class NyxCommandExecutor {
  constructor(private readonly bootstrap: NyxBootstrapService, private readonly registry: NyxCliRegistryService, private readonly resolver: NyxCommandResolver, private readonly resources: NyxResourceResolver, private readonly handoffs: HandoffStore, private readonly profiles: NyxExecutionProfileService) {}
  async execute(request: CommandRequest, owner = 'api-key') {
    const locator = await this.bootstrap.locate();
    const { cli, hash } = await this.registry.current(locator);
    const profile = await this.profiles.apply(locator, cli, hash);
    const plan = this.resolver.resolve(profile.cli, request);
    const loaded = await this.resources.load(locator, plan);
    for (const file of loaded.files) assertNoSecrets(file.content);
    const fif = plan.contract.adapter === 'context.initialize.v1' ? await this.handoffs.initialize(owner, plan.conversationId, loaded.handoffs!, {
      command: { name: plan.name, targets: plan.targets, depth: plan.depth }, canonical: locator.canonical,
      cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash },
      loaded_context: { areas: plan.targets, sources: loaded.files.map(f => f.key) },
      source_refs: loaded.files.map(f => ({ key: f.key, ref: f.ref, sha256: f.sha256, bytes: f.bytes, returned: f.visible })),
    }) : undefined;
    return {
      schema: plan.contract.response, status: 'COMPLETE', conversation_id: fif?.conversationId,
      fif: fif ? { id: fif.id, kind: fif.kind, ref: fif.ref, sha256: fif.sha256, verified: fif.verified } : null,
      files_to_paste: loaded.files.filter(f => f.visible).map(f => ({ name: f.ref.path.split('/').pop(), key: f.key, content: f.content, ref: f.ref, sha256: f.sha256 })),
      metadata: { command: plan.name, targets: plan.targets, depth: plan.depth, cli: { version: cli.version, sha256: hash, profile_sha256: profile.hash }, source_receipts: loaded.files.map(({ content, ...receipt }) => receipt), warnings: loaded.warnings },
    };
  }
}
