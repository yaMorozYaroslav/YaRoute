import { BadRequestException, Injectable } from '@nestjs/common';
import { NyxCommandExecutor } from '../nyx/command-executor.service';
import { InitInput } from './init.types';
@Injectable()
export class InitService {
  constructor(private readonly commands: NyxCommandExecutor) {}
  initialize(input: InitInput = {}, owner = 'api-key') {
    // Compatibility endpoint only. Command semantics and defaults are resolved by the registry.
    if (input.target && input.targets) throw new BadRequestException('Use target or targets, not both');
    if (input.conversationId && input.sessionId && input.conversationId !== input.sessionId) throw new BadRequestException('Conversation identity conflict');
    return this.commands.execute({
      command: 'ini',
      args: input.targets ?? (input.target ? input.target.split(/\s+/).filter(Boolean) : []),
      depth: input.depth,
      scope: input.scope,
      conversationId: input.conversationId ?? input.sessionId,
    }, owner);
  }
}
