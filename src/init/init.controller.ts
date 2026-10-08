import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { InitService } from './init.service';
import { BootstrapAuditService } from './bootstrap-audit.service';
import { InitInput } from './init.types';

@Controller('init')
export class InitController {
  constructor(private readonly init: InitService, private readonly audit: BootstrapAuditService) {}

  @Post('check')
  check(@Body() body: InitInput) { return this.audit.initialize(body ?? {}); }

  @Post()
  async initialize(@Body() body: InitInput) {
    try { return await this.init.initialize(body ?? {}); }
    catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]+(?::[A-Za-z0-9_:.-]{1,128})?$/.test(error.message) ? error.message : 'NYX_OPERATION_FAILED';
      throw new BadRequestException({ status: 'FAILED_RESOLVE_OR_VERIFY', message: code });
    }
  }
}
