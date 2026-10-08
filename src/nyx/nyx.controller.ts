import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { NyxCommandExecutor } from './command-executor.service';
import { CommandRequest } from './runtime.schema';
@Controller('nyx')
export class NyxController {
  constructor(private readonly commands: NyxCommandExecutor) {}
  @Post('execute')
  async execute(@Body() input: CommandRequest) {
    try { return await this.commands.execute(input); }
    catch { throw new BadRequestException({ status: 'FAILED_RESOLVE_OR_VERIFY', message: 'Nyx execution failed; verify the private bootstrap, CLI contract, routing and handoff storage.' }); }
  }
}
