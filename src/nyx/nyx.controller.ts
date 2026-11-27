import { Body, Controller, Get, Post, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { NyxKeyService } from './key.service';
import { NyxCommandExecutor } from './command-executor.service';
import { CommandRequest } from './runtime.schema';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';
import { NyxHeadLibraryService } from './head-library.service';
import { NyxExecutionProfileService } from './execution-profile.service';
import { buildNyxRuntimeChecklist } from './runtime-health-checklist';

@Controller('nyx')
export class NyxController {
  constructor(
    private readonly commands: NyxCommandExecutor,
    private readonly bootstrap: NyxBootstrapService,
    private readonly registry: NyxCliRegistryService,
    private readonly head: NyxHeadLibraryService,
    private readonly keys: NyxKeyService,
    private readonly profiles: NyxExecutionProfileService,
  ) {}


  /**
   * Private, read-only diagnostics. The API guard blocks this route in public
   * tenant mode, and requires X-Nyx-Key in the private operator runtime.
   * Do not turn into a Public endpoint: live canonical paths are sensitive.
   */
  @Get('checklist')
  async checklist() {
    const runtimeCommit = process.env.HEROKU_SLUG_COMMIT || (() => {
      try { return (require('../build-info.json') as { commit?: string }).commit || ''; }
      catch { return ''; }
    })();
    try {
      const locator = await this.bootstrap.locate();
      const resolved = await this.registry.current(locator);
      const profile = await this.profiles.inspect(locator, resolved.hash);
      let effectiveCommands: string[] | undefined;
      if (profile.ready) {
        try {
          const applied = await this.profiles.apply(locator, resolved.cli, resolved.hash);
          effectiveCommands = Object.entries(applied.cli.commands)
            .filter(([, contract]) => Boolean(contract.execution)).map(([name]) => name);
        } catch { effectiveCommands = undefined; }
      }
      return buildNyxRuntimeChecklist({
        runtimeCommit, canonical: locator.canonical,
        cli: { version: resolved.cli.version, sha256: resolved.hash, commands: resolved.cli.commands },
        profile, effectiveCommands,
      });
    } catch {
      return buildNyxRuntimeChecklist({ runtimeCommit, sourceError: 'CANONICAL_SOURCE_NOT_VERIFIED' });
    }
  }

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
