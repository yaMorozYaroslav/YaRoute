import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

@Injectable()
export class McpAuthService {
  private client?: ReturnType<typeof jwksClient>;

  protectedResourceMetadata() {
    const publicUrl = this.required('NYX_PUBLIC_URL').replace(/\/$/, '');
    const issuer = this.required('NYX_OAUTH_ISSUER').replace(/\/$/, '');

    return {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: this.scopes(),
      bearer_methods_supported: ['header'],
      resource_name: 'NestNyx MCP',
    };
  }

  async authorize(req: Request, res: Response): Promise<boolean> {
    const token = this.bearer(req);
    if (!token) {
      this.challenge(res, 'invalid_token', 'Bearer access token required');
      return false;
    }

    try {
      const payload = await this.verify(token);
      const granted = this.tokenScopes(payload.scope);
      const requiredScopes = this.scopes();
      const missing = requiredScopes.filter((scope) => !granted.has(scope));

      if (missing.length) {
        this.challenge(
          res,
          'insufficient_scope',
          `Missing required scope(s): ${missing.join(' ')}`,
        );
        return false;
      }

      return true;
    } catch {
      this.challenge(res, 'invalid_token', 'Invalid or expired access token');
      return false;
    }
  }

  private verify(token: string): Promise<JwtPayload> {
    const issuer = this.required('NYX_OAUTH_ISSUER').replace(/\/$/, '');
    const audience = this.required('NYX_OAUTH_AUDIENCE');
    const algorithms = (process.env.NYX_OAUTH_ALGORITHMS || 'RS256')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean) as jwt.Algorithm[];

    const client = this.jwks(issuer);

    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          if (!header.kid) {
            callback(new Error('JWT has no kid'));
            return;
          }
          client.getSigningKey(header.kid, (error, key) => {
            if (error || !key) {
              callback(error || new Error('Signing key not found'));
              return;
            }
            callback(null, key.getPublicKey());
          });
        },
        { issuer, audience, algorithms },
        (error, decoded) => {
          if (error || !decoded || typeof decoded === 'string') {
            reject(error || new Error('Invalid JWT payload'));
            return;
          }
          resolve(decoded);
        },
      );
    });
  }

  private jwks(issuer: string) {
    if (!this.client) {
      const uri =
        process.env.NYX_OAUTH_JWKS_URI?.trim() || `${issuer}/.well-known/jwks.json`;
      this.client = jwksClient({ jwksUri: uri, cache: true, rateLimit: true });
    }
    return this.client;
  }

  private bearer(req: Request): string | undefined {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ')) return undefined;
    const token = value.slice(7).trim();
    return token || undefined;
  }

  private scopes(): string[] {
    return (process.env.NYX_OAUTH_SCOPES || 'nyx.read,nyx.write')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private tokenScopes(scope: unknown): Set<string> {
    if (typeof scope !== 'string') return new Set();
    return new Set(scope.split(/\s+/).filter(Boolean));
  }

  private challenge(res: Response, error: string, description: string) {
    const publicUrl = this.required('NYX_PUBLIC_URL').replace(/\/$/, '');
    const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${metadataUrl}", error="${error}", error_description="${description}"`,
    );
    res.status(401).json({ error, error_description: description });
  }

  private required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required for MCP OAuth`);
    return value;
  }
}
