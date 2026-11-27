import { Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { PrivateLegacyBrokerService } from './private-legacy-broker.service';

/** Private deployment only. No client-supplied remote names, tokens or file data. */
@Public()
@Controller('internal/private-legacy')
export class PrivateLegacyBrokerController {
  constructor(private readonly broker: PrivateLegacyBrokerService) {}

  @Post('execute')
  async execute(@Headers('authorization') authorization: string,
                @Res() res: Response) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (process.env.NYX_PRIVATE_BROKER_SERVER_ENABLED !== 'true' ||
        process.env.NYX_DEPLOYMENT_MODE !== 'private')
      return res.status(404).json({error:'not_found'});
    try {
      const data = await this.broker.execute(authorization);
      return res.status(200).json(data);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'PRIVATE_BROKER_RATE_LIMITED') {
        res.setHeader('Retry-After','60');
        return res.status(429).json({error:'rate_limited'});
      }
      if (code === 'PRIVATE_BROKER_BACKEND_UNAVAILABLE')
        return res.status(503).json({error:'temporarily_unavailable'});
      return res.status(403).json({error:'access_denied'});
    }
  }
}
