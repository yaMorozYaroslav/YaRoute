import { Injectable } from '@nestjs/common';
import { Cli, CommandRequest, requestSchema } from './runtime.schema';

const modifierPattern = /^o([lg])([bnd])$/i;
const depthByCode = { b: 'basic', n: 'normal', d: 'deep' } as const;
const codeByDepth = { basic: 'B', normal: 'N', deep: 'D' } as const;

@Injectable()
export class NyxCommandResolver {
  resolve(cli: Cli, raw: CommandRequest) {
    const request = requestSchema.parse(raw);
    // "help" is a transport-facing spelling of canonical Head command "hel".
    // Never add a new Head command, and never override a real command named help.
    const query = request.command.toLowerCase() === 'help' && !Object.prototype.hasOwnProperty.call(cli.commands,'help') ? 'hel' : request.command.toLowerCase();
    const match = Object.entries(cli.commands).find(([name, c]) => name.toLowerCase() === query || c.aliases?.some(a => a.toLowerCase() === query));
    if (!match) throw new Error('UNKNOWN_COMMAND');
    const [name, definition] = match;
    const contract = definition.execution;
    if (!contract) throw new Error('COMMAND_EXECUTION_CONTRACT_MISSING');
    if (Object.values(contract.sources).flat().some(s => s.perTarget && !s.key.includes('{target}'))) throw new Error('TARGET_CONTRACT_INVALID');

    const modifiers: Array<{ scope: 'local' | 'global'; depth: 'basic' | 'normal' | 'deep' }> = [];
    const operations: Array<'++' | '--'> = [];
    const targetArgs: string[] = [];
    for (const token of request.args) {
      // Scope/depth modifiers are interpreted only for contracts that explicitly opt into chat scope.
      // Historical commands without that contract keep their previous argument semantics.
      if (!contract.scope) {
        if (token === '++' || token === '--') throw new Error('SCOPE_NOT_SUPPORTED');
        targetArgs.push(token);
        continue;
      }
      const modifier = modifierPattern.exec(token);
      if (modifier) {
        modifiers.push({ scope: modifier[1].toLowerCase() === 'l' ? 'local' : 'global', depth: depthByCode[modifier[2].toLowerCase() as keyof typeof depthByCode] });
      } else if (token === '++' || token === '--') operations.push(token);
      else targetArgs.push(token);
    }
    if (modifiers.length > 1) throw new Error('MODIFIER_CONFLICT');
    if (operations.length > 1) throw new Error('CONFIG_OPERATION_CONFLICT');
    const explicit = modifiers[0];

    if ((explicit || request.scope || operations.length) && !contract.scope) throw new Error('SCOPE_NOT_SUPPORTED');
    if (request.depth && explicit && request.depth !== explicit.depth) throw new Error('MODIFIER_DEPTH_CONFLICT');
    if (request.scope && explicit && request.scope !== explicit.scope) throw new Error('MODIFIER_SCOPE_CONFLICT');

    const depth = request.depth ?? explicit?.depth ?? contract.depth.default;
    if (!contract.depth.allowed.includes(depth)) throw new Error('DEPTH_NOT_ALLOWED');
    const scope = request.scope ?? explicit?.scope ?? contract.scope?.default;
    const modifier = scope ? `o${scope === 'local' ? 'L' : 'G'}${codeByDepth[depth]}` : undefined;
    const modifierSource = explicit ? 'explicit' : (request.scope || request.depth) ? 'request' : contract.scope ? 'default' : undefined;

    if ((!contract.arguments.targets && targetArgs.length) || targetArgs.length > contract.arguments.maxTargets) throw new Error('ARGUMENTS_NOT_ALLOWED');
    const targets = Array.from(new Map(targetArgs.map(a => [a.toLowerCase(), a])).values());
    if (contract.adapter === 'context.initialize.v1') {
      // A syntactically typed selector must never degrade to a legacy bare target.
      // The typed manifest/config/status resolver and its receipts are not yet implemented here.
      // Fail closed instead of returning a misleading COMPLETE/FIF for a missing resource.
      for (const target of targets) {
        if (/^(?:core_skill|domain|area):[A-Za-z][A-Za-z0-9_-]{0,63}$/i.test(target))
          throw new Error('TYPED_RESOURCE_ADAPTER_NOT_READY');
      }
      // Head H31 declares these collisions. When a CLI advertises its typed-resource
      // contract, an untyped ambiguous target is invalid, regardless of runtime profile.
      const typed = (definition as { typed_resource_resolution?: { collisions?: unknown } }).typed_resource_resolution;
      if (typed && Array.isArray(typed.collisions)) {
        const ambiguous = new Set(typed.collisions.filter((x): x is string => typeof x === 'string')
          .map(x => x.trim().split(/\s+/)[0].toLowerCase()));
        for (const target of targets)
          if (ambiguous.has(target.toLowerCase())) throw new Error('AMBIGUOUS_TYPED_RESOURCE');
      }
    }

    if (operations.length) {
      if (contract.adapter !== 'context.initialize.v1' || !contract.scope) throw new Error('CONFIG_OPERATION_NOT_SUPPORTED');
      if (explicit || request.scope || request.depth || targets.length) throw new Error('CONFIG_OPERATION_INVALID');
      if (!request.conversationId) throw new Error('CONVERSATION_ID_REQUIRED');
    } else if (explicit && contract.adapter === 'context.initialize.v1' && !targets.length) {
      // `nyx ini` may use its default, but a standalone explicit modifier is not a target.
      throw new Error('MODIFIER_REQUIRES_TARGET');
    }

    if (contract.adapter === 'context.initialize.v1' && (contract.mutation !== 'conversation-artifact' || !contract.handoffsKey || !contract.verification.artifactReadback)) throw new Error('INIT_CONTRACT_UNSAFE');
    if ((contract.adapter === 'context.read.v1' || contract.adapter === 'context.help.v1') && contract.mutation !== 'none') throw new Error('READ_CONTRACT_UNSAFE');
    if (contract.adapter === 'context.help.v1' && (name !== 'hel' || contract.scope || contract.arguments.targets || contract.arguments.maxTargets !== 0 || contract.pathsVisible || contract.verification.artifactReadback || Object.values(contract.sources).some(s=>s.length))) throw new Error('HELP_CONTRACT_UNSAFE');
    if (contract.adapter === 'context.summarize.v1') {
      if (contract.mutation !== 'conversation-artifact' || !contract.handoffsKey || !contract.verification.artifactReadback) throw new Error('SUM_CONTRACT_UNSAFE');
      if (!request.conversationId) throw new Error('CONVERSATION_ID_REQUIRED');
      if (!request.payload) throw new Error('SUM_PAYLOAD_REQUIRED');
    } else if (request.payload) throw new Error('PAYLOAD_NOT_SUPPORTED');
    return {
      name, contract, depth, scope, modifier, modifierSource, targets, conversationId: request.conversationId, payload: request.payload,
      scopeAction: operations[0] === '++' ? 'upgrade' as const : operations[0] === '--' ? 'downgrade' as const : undefined,
    };
  }
}
