import { Body, Controller, Get, Post, BadRequestException } from '@nestjs/common';
import { NyxCommandExecutor } from './command-executor.service';
import { CommandRequest } from './runtime.schema';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';
import { NyxHeadLibraryService } from './head-library.service';

@Controller('nyx')
export class NyxController {
  constructor(
    private readonly commands: NyxCommandExecutor,
    private readonly bootstrap: NyxBootstrapService,
    private readonly registry: NyxCliRegistryService,
    private readonly head: NyxHeadLibraryService,
  ) {}

  @Get('head')
  async headStatus() {
    const locator = await this.bootstrap.locate();
    const cli = await this.registry.current(locator);
    return {
      status: 'READY',
      role: 'constitution-library',
      canonical: locator.canonical,
      cli: { version: cli.cli.version, sha256: cli.hash },
      library: this.head.snapshot(),
      source_of_truth: 'canonical Head bundle',
      mutation: 'read-only runtime cache; canonical Head lifecycle remains separate',
    };
  }

  @Post('execute')
  async execute(@Body() input: CommandRequest) {
    try { return await this.commands.execute(input); }
    catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const message = /^[A-Z][A-Z_]+(?::[A-Za-z0-9_:.-]{1,128})?$/.test(raw) ? raw : 'NYX_OPERATION_FAILED';
      throw new BadRequestException({ status: 'FAILED_RESOLVE_OR_VERIFY', message });
    }
  }
}
