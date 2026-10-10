import { Body, Controller, Get, Post, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { NyxKeyService } from './key.service';
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
    private readonly keys: NyxKeyService,
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

  @Post('key')
  async key(@Body() input: { stage: 'oF' | 'oS'; scope?: 'local' | 'global'; transactionId: string; candidates?: Array<{ id: string; target: 'head' | 'body' | 'footer'; description: string; confidence: number; source: string; blocked?: boolean }> }) {
    if (process.env.NYX_KEY_HTTP_ENABLED !== 'true') throw new ServiceUnavailableException('KEY_ENDPOINT_DISABLED_PENDING_AUTH_AND_CANONICAL_VALIDATION');
    try {
      if (!input || !['oF','oS'].includes(input.stage) || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.transactionId) || (input.scope && !['local','global'].includes(input.scope)) || (input.candidates && (!Array.isArray(input.candidates) || input.candidates.length > 100))) throw new Error('KEY_REQUEST_INVALID');
      return await this.keys.execute(input);
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const message = /^[A-Z][A-Z_]+$/.test(raw) ? raw : 'KEY_OPERATION_FAILED';
      throw new BadRequestException({ status: 'FAILED', message });
    }
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
