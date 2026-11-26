import jwt, { JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import type { VerifiedGoogleIdentity } from './private-legacy-access.policy';

/**
 * Google identity proof for a future owner-link callback, NOT Google Drive
 * authorization and NOT a standalone grant for the private Rclone broker.
 *
 * Caller MUST use a one-time server-stored OAuth state + nonce, an exact
 * registered redirect URI, and the configured Google OAuth client ID.
 * Never accept audience, nonce, public keys or identity claims from an MCP
 * tool argument, HTTP header or unauthenticated caller.
 */
export type GoogleSigningKeyResolver = (kid: string) => Promise<string>;

const googleKeys = jwksClient({
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
  timeout: 5000,
});

const defaultKeyResolver: GoogleSigningKeyResolver = async kid =>
  (await googleKeys.getSigningKey(kid)).getPublicKey();

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

export class PrivateLegacyGoogleIdTokenVerifier {
  constructor(private readonly resolveSigningKey: GoogleSigningKeyResolver = defaultKeyResolver) {}

  async verify(
    idToken: string,
    expected: Readonly<{ clientId: string; nonce: string }>,
  ): Promise<VerifiedGoogleIdentity> {
    if (typeof idToken !== 'string' || idToken.length > 8192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken) ||
        !expected || typeof expected.clientId !== 'string' ||
        !/^[A-Za-z0-9_.-]{10,256}$/.test(expected.clientId) ||
        typeof expected.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{20,128}$/.test(expected.nonce)) {
      throw new Error('PRIVATE_GOOGLE_ID_TOKEN_INVALID');
    }

    let claims: JwtPayload;
    try {
      claims = await new Promise<JwtPayload>((resolve, reject) => {
        jwt.verify(idToken, (header, done) => {
          if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) {
            done(new Error('PRIVATE_GOOGLE_SIGNING_KEY_INVALID'));
            return;
          }
          this.resolveSigningKey(header.kid).then(
            key => done(null, key),
            () => done(new Error('PRIVATE_GOOGLE_SIGNING_KEY_INVALID')),
          );
        }, {
          algorithms: ['RS256'],
          issuer: [...GOOGLE_ISSUERS],
          audience: expected.clientId,
          clockTolerance: 30,
        }, (error, decoded) => {
          if (error || !decoded || typeof decoded !== 'object') {
            reject(new Error('PRIVATE_GOOGLE_ID_TOKEN_INVALID'));
          } else {
            resolve(decoded as JwtPayload);
          }
        });
      });
    } catch {
      // Do not leak raw token, Google subject, configured client or key failures.
      throw new Error('PRIVATE_GOOGLE_ID_TOKEN_INVALID');
    }

    const now = Math.floor(Date.now() / 1000);
    const normalizedEmail = typeof claims.email === 'string'
      ? claims.email.trim().toLowerCase() : '';
    if (typeof claims.iss !== 'string' ||
        !GOOGLE_ISSUERS.includes(claims.iss as typeof GOOGLE_ISSUERS[number]) ||
        claims.aud !== expected.clientId ||
        (claims.azp !== undefined && claims.azp !== expected.clientId) ||
        claims.nonce !== expected.nonce ||
        typeof claims.sub !== 'string' ||
        !/^[0-9A-Za-z_-]{1,256}$/.test(claims.sub) ||
        claims.email_verified !== true ||
        normalizedEmail.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
        typeof claims.exp !== 'number' || claims.exp <= now - 30 ||
        typeof claims.iat !== 'number' ||
        claims.iat < now - 600 || claims.iat > now + 30) {
      throw new Error('PRIVATE_GOOGLE_ID_TOKEN_INVALID');
    }

    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: normalizedEmail,
      emailVerified: true,
    };
  }
}
