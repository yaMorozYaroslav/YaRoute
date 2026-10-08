import { Injectable } from '@nestjs/common';
import { Cli, CommandRequest, requestSchema } from './runtime.schema';
@Injectable()
export class NyxCommandResolver {
  resolve(cli: Cli, raw: CommandRequest) {
    const request = requestSchema.parse(raw);
    const match = Object.entries(cli.commands).find(([name, c]) => name.toLowerCase() === request.command.toLowerCase() || c.aliases?.some(a => a.toLowerCase() === request.command.toLowerCase()));
    if (!match) throw new Error('UNKNOWN_COMMAND');
    const [name, definition] = match;
    const contract = definition.execution;
    if (!contract) throw new Error('COMMAND_EXECUTION_CONTRACT_MISSING');
    if (Object.values(contract.sources).flat().some(s => s.perTarget && !s.key.includes('{target}'))) throw new Error('TARGET_CONTRACT_INVALID');
    const depth = request.depth ?? contract.depth.default;
    if (!contract.depth.allowed.includes(depth)) throw new Error('DEPTH_NOT_ALLOWED');
    if ((!contract.arguments.targets && request.args.length) || request.args.length > contract.arguments.maxTargets) throw new Error('ARGUMENTS_NOT_ALLOWED');
    const targets = Array.from(new Map(request.args.map(a => [a.toLowerCase(), a])).values());
    if (contract.adapter === 'context.initialize.v1' && (contract.mutation !== 'conversation-artifact' || !contract.handoffsKey || !contract.verification.artifactReadback)) throw new Error('INIT_CONTRACT_UNSAFE');
    if (contract.adapter === 'context.read.v1' && contract.mutation !== 'none') throw new Error('READ_CONTRACT_UNSAFE');
    return { name, contract, depth, targets, conversationId: request.conversationId };
  }
}
