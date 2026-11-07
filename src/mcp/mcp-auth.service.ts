import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { privateDevSingleGoogleOwnerAllowed, privateSingleGoogleOwnerAllowed } from './private-dev-google-login.policy';
import { assertPublicTenantGoogleSubject } from '../connectors/public-tenant-provider.policy';

/** A temporary issuer/JWKS failure is not evidence that the user's grant expired. */
class SigningKeysTemporarilyUnavailable extends Error {
  constructor() {
    super('Signing keys temporarily unavailable');
    this.name = 'SigningKeysTemporarilyUnavailable';
  }
}

function isTemporaryJwksFailure(error: Error): boolean {
  // jwks-rsa and Node HTTP clients can wrap the original network error in
  // cause/response objects. Inspect only structured error metadata: matching
  // arbitrary message text could misclassify an unknown signing key as an outage.
  const temporaryCodes = new Set([
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
    'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ]);
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    const candidate = current as {
      name?: unknown; code?: unknown; statusCode?: unknown; status?: unknown;
      response?: { status?: unknown }; cause?: unknown;
    };
    const status = typeof candidate.statusCode === 'number' ? candidate.statusCode
      : typeof candidate.status === 'number' ? candidate.status
      : candidate.response?.status;
    if (typeof status === 'number' && (status === 429 ||
        (status >= 500 && status <= 599))) return true;
    if (candidate.name === 'JwksRateLimitError' ||
        candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
      return true;
    }
    if (typeof candidate.code === 'string' && temporaryCodes.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

@Injectable()
export class McpAuthService {
  private client?: ReturnType<typeof jwksClient>;

  protectedResourceMetadata() {
    const publicUrl = this.required('NYX_PUBLIC_URL').replace(/\/$/, '');
    const issuer = this.required('NYX_OAUTH_ISSUER');

    return {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: this.scopes(),
      bearer_methods_supported: ['header'],
      resource_name: `${process.env.NYX_SERVICE_NAME?.trim() || 'NestNyx'} MCP`,
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

      if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('Missing subject');
      // The current rclone configuration is process-wide, not scoped to the OAuth subject.
      // Until per-user storage connections exist, explicitly allow only private owners.
      // Fail closed if NYX_PRIVATE_OAUTH_SUBJECTS is unset or empty.
      const allowedSubjects = new Set(
        (process.env.NYX_PRIVATE_OAUTH_SUBJECTS || '')
          .split(',')
          .map((subject) => subject.trim())
          .filter(Boolean),
      );
      // Public connector mode has verified JWT tenants and NO legacy shared
      // Rclone, CLI, or private handoff tools. Keep strict allowlist in private mode.
      const connectorMode = process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true';
      // Only trusted issuer-signed Google OAuth logins can reach public MEGA
      // in the configured MEGA-only rollout. Do not accept a client-supplied
      // email or subject argument as proof of the Google login.
      if (connectorMode) {
        try {
          assertPublicTenantGoogleSubject(payload.sub);
        } catch {
          res.status(403).json({
            error: 'access_denied',
            error_description: 'Sign in with Google before connecting MEGA',
          });
          return false;
        }
      }
      if (!connectorMode && !allowedSubjects.has(payload.sub)) {
        res.status(403).json({ error: 'access_denied', error_description: 'Private NYX instance: user not authorized' });
        return false;
      }
      // General private-instance hardening, separately opt-in on Pro. Reject
      // missing, duplicate or non-Google owner subjects before any legacy tool
      // can access process-wide Rclone credentials. Never infer email from sub.
      if (!connectorMode &&
          process.env.NYX_PRIVATE_SINGLE_GOOGLE_OWNER === 'true' &&
          !privateSingleGoogleOwnerAllowed(payload, process.env)) {
        res.status(403).json({
          error: 'access_denied',
          error_description: 'Private Google owner verification required',
        });
        return false;
      }
      // Opt-in Dev-only second gate: restrict the legacy private Rclone tools
      // to ONE operator-approved Google-social OAuth subject. Identity claims
      // are read only from the already signature-verified MCP JWT, never from
      // request fields. The Dev operator must separately verify that this
      // subject belongs to the intended Google account before enabling it.
      if (!connectorMode &&
          process.env.NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER === 'true' &&
          !privateDevSingleGoogleOwnerAllowed(payload, process.env)) {
        res.status(403).json({
          error: 'access_denied',
          error_description: 'Private Dev Google owner verification required',
        });
        return false;
      }
      res.locals.nyxSubject = payload.sub;
      return true;
    } catch (error) {
      if (error instanceof SigningKeysTemporarilyUnavailable) {
        // Do not issue WWW-Authenticate here: this is an issuer outage, not a
        // revoked or invalid user grant. Fail closed and let the client retry.
        console.warn('[MCP OAuth] temporary signing-key lookup failure');
        res.setHeader('Retry-After', '15');
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({
          error: 'temporarily_unavailable',
          error_description: 'Authentication provider temporarily unavailable; retry later',
        });
        return false;
      }
      console.error(
        '[MCP OAuth] verification failed:',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      this.challenge(res, 'invalid_token', 'Invalid or expired access token');
      return false;
    }
  }

  private verify(token: string): Promise<JwtPayload> {
    const issuer = this.required('NYX_OAUTH_ISSUER');
    const audience = this.required('NYX_OAUTH_AUDIENCE');
    const algorithms = (process.env.NYX_OAUTH_ALGORITHMS || 'RS256')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean) as jwt.Algorithm[];

    const client = this.jwks(issuer);

    return new Promise((resolve, reject) => {
      let temporaryKeyLookupFailure = false;
      jwt.verify(
        token,
        (header, callback) => {
          if (!header.kid) {
            callback(new Error('JWT has no kid'));
            return;
          }
          client.getSigningKey(header.kid, (error, key) => {
            if (error || !key) {
              // jsonwebtoken wraps key-provider errors as JsonWebTokenError.
              // Record the original classification before that wrapping.
              if (error && isTemporaryJwksFailure(error)) temporaryKeyLookupFailure = true;
              callback(error || new Error('Signing key not found'));
              return;
            }
            callback(null, key.getPublicKey());
          });
        },
        { issuer, audience, algorithms },
        (error, decoded) => {
          if (temporaryKeyLookupFailure) {
            reject(new SigningKeysTemporarilyUnavailable());
            return;
          }
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
      const issuerBase = issuer.replace(/\/$/, '');
      const uri =
        process.env.NYX_OAUTH_JWKS_URI?.trim() ||
        `${issuerBase}/.well-known/jwks.json`;
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
