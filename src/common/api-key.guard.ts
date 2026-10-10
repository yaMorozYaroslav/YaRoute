import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // Never expose legacy process-wide Rclone/NYX endpoints, not even with a
    // legacy API key, when the deployment accepts public OAuth tenants.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') {
      throw new UnauthorizedException('Legacy HTTP API disabled in public connector mode');
    }

    const expected = process.env.NYX_API_KEY;
    if (!expected) throw new UnauthorizedException('NYX_API_KEY is not configured');

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = request.headers['x-nyx-key'];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) throw new UnauthorizedException('Missing X-Nyx-Key');

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid X-Nyx-Key');
    }
    return true;
  }
}
