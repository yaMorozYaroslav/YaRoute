import { All, Body, Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { McpAuthService } from './mcp-auth.service';
import { McpService } from './mcp.service';

@Public()
@Controller()
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly auth: McpAuthService,
  ) {}

  @Get('.well-known/oauth-protected-resource')
  protectedResourceMetadata() {
    return this.auth.protectedResourceMetadata();
  }

  @All('mcp')
  async handle(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    if (!(await this.auth.authorize(req, res))) return;
    return this.mcp.handle(req, res, body);
  }
}
