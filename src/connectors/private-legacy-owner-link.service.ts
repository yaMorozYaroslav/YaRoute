import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PrivateLegacyGoogleIdTokenVerifier } from './private-legacy-google-identity';

/**
 * Separately verified OIDC ownership link. This service stores no Rclone
 * credentials, Drive grants, Google tokens, or delegation to a legacy broker.
 * It is disabled unless an isolated public deployment opts in explicitly.
 */
@Injectable()
export class PrivateLegacyOwnerLinkService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private key?: Buffer;
  private readonly verifier = new PrivateLegacyGoogleIdTokenVerifier();

  private settings() {
    if (process.env.NYX_PRIVATE_OWNER_LINK_ENABLED !== 'true' ||
        process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' ||
        process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true') {
      throw new Error('PRIVATE_OWNER_LINK_NOT_ENABLED');
    }
    const email = (process.env.NYX_PRIVATE_LEGACY_OWNER_GOOGLE_EMAIL || '').trim().toLowerCase();
    const subject = (process.env.NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT || '').trim();
    const issuer = (process.env.NYX_OAUTH_ISSUER || '').trim();
    const clientId = (process.env.NYX_PRIVATE_OWNER_GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = process.env.NYX_PRIVATE_OWNER_GOOGLE_CLIENT_SECRET || '';
    const publicUrl = (process.env.NYX_PUBLIC_URL || '').replace(/\/$/, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^[^\x00-\x1f\s]{1,500}$/.test(subject) ||
        !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(issuer) ||
        !/^[A-Za-z0-9_.-]{10,256}$/.test(clientId) ||
        !clientSecret || clientSecret.length > 512 ||
        !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(publicUrl)) {
      throw new Error('PRIVATE_OWNER_LINK_CONFIGURATION_INVALID');
    }
    return {email, subject, issuer, clientId, clientSecret, publicUrl};
  }

  async onModuleInit() {
    if (process.env.NYX_PRIVATE_OWNER_LINK_ENABLED !== 'true') return;
    this.settings();
    const encoded = process.env.NYX_STORAGE_ENCRYPTION_KEY || '';
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== 32 ||
        key.toString('base64') !== encoded || !process.env.DATABASE_URL) {
      throw new Error('PRIVATE_OWNER_LINK_VAULT_UNAVAILABLE');
    }
    this.key = key;
    this.pool = new Pool({connectionString: process.env.DATABASE_URL, max: 2});
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_private_owner_link_states_v1 (' +
      'digest text PRIMARY KEY, mcp_subject text NOT NULL, encrypted_challenge text NOT NULL, ' +
      'expires_at timestamptz NOT NULL)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_private_owner_links_v1 (' +
      'id smallint PRIMARY KEY CHECK (id = 1), ' +
      'mcp_issuer text NOT NULL, mcp_subject text NOT NULL, ' +
      'google_subject text NOT NULL, google_email text NOT NULL, linked_at timestamptz NOT NULL DEFAULT now())');
  }
  async onModuleDestroy() { await this.pool?.end(); }

  private db(): Pool {
    if (!this.pool || !this.key) throw new Error('PRIVATE_OWNER_LINK_NOT_ENABLED');
    return this.pool;
  }
  private approved(ownerId: string): boolean {
    const cfg = this.settings();
    return ownerId === 'oauth:' + cfg.subject;
  }
  private seal(digest: string, challenge: {verifier: string; nonce: string}): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv);
    cipher.setAAD(Buffer.from(digest));
    const data = Buffer.concat([cipher.update(JSON.stringify(challenge), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private open(digest: string, sealed: string): {verifier: string; nonce: string} {
    const data = Buffer.from(sealed, 'base64');
    if (data.length < 29) throw new Error('PRIVATE_OWNER_LINK_STATE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.key!, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(digest));
    decipher.setAuthTag(data.subarray(12, 28));
    const result: unknown = JSON.parse(Buffer.concat([
      decipher.update(data.subarray(28)), decipher.final(),
    ]).toString('utf8'));
    if (!result || typeof result !== 'object') throw new Error('PRIVATE_OWNER_LINK_STATE_INVALID');
    const challenge = result as {verifier?: unknown; nonce?: unknown};
    if (typeof challenge.verifier !== 'string' ||
        !/^[A-Za-z0-9_-]{40,128}$/.test(challenge.verifier) ||
        typeof challenge.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{20,128}$/.test(challenge.nonce)) {
      throw new Error('PRIVATE_OWNER_LINK_STATE_INVALID');
    }
    return {verifier: challenge.verifier, nonce: challenge.nonce};
  }

  async status(ownerId: string) {
    this.db();
    if (!this.approved(ownerId)) return {eligible: false, linked: false};
    const cfg = this.settings();
    const row = await this.db().query('SELECT mcp_issuer,mcp_subject,google_email FROM nyx_private_owner_links_v1 WHERE id=1');
    const linked = row.rowCount === 1 && row.rows[0].mcp_issuer === cfg.issuer &&
      row.rows[0].mcp_subject === cfg.subject && row.rows[0].google_email === cfg.email;
    return {eligible: true, linked, privateRcloneAvailable: false};
  }

  /** Internal, server-only proof for signing a narrow broker delegation.
   * Never return this record through an MCP tool or the public connections UI.
   */
  async trustedBrokerIdentity(ownerId: string) {
    this.db();
    if (!this.approved(ownerId)) throw new Error('PRIVATE_OWNER_LINK_NOT_AUTHORIZED');
    const cfg = this.settings();
    const result = await this.db().query(
      'SELECT mcp_issuer,mcp_subject,google_subject,google_email ' +
      'FROM nyx_private_owner_links_v1 WHERE id=1');
    const row = result.rows[0];
    if (result.rowCount !== 1 || row.mcp_issuer !== cfg.issuer ||
        row.mcp_subject !== cfg.subject || row.google_email !== cfg.email ||
        typeof row.google_subject !== 'string' ||
        !/^[A-Za-z0-9_-]{5,255}$/.test(row.google_subject)) {
      throw new Error('PRIVATE_OWNER_LINK_NOT_VERIFIED');
    }
    return {mcpIssuer:cfg.issuer,mcpSubject:cfg.subject,
      googleSubject:row.google_subject};
  }

  async begin(ownerId: string) {
    const cfg = this.settings();
    this.db();
    if (!this.approved(ownerId)) throw new Error('PRIVATE_OWNER_LINK_NOT_AUTHORIZED');
    const state = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(state).digest('hex');
    const verifier = randomBytes(48).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.db().query('DELETE FROM nyx_private_owner_link_states_v1 WHERE mcp_subject=$1', [cfg.subject]);
    await this.db().query('INSERT INTO nyx_private_owner_link_states_v1 ' +
      '(digest,mcp_subject,encrypted_challenge,expires_at) VALUES ($1,$2,$3,now()+interval \'10 minutes\')',
      [digest,cfg.subject,this.seal(digest,{verifier,nonce})]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.publicUrl + '/connect/private-owner/callback');
    url.searchParams.set('response_type','code');
    url.searchParams.set('scope','openid email');
    url.searchParams.set('state',state);
    url.searchParams.set('nonce',nonce);
    url.searchParams.set('code_challenge',challenge);
    url.searchParams.set('code_challenge_method','S256');
    url.searchParams.set('prompt','select_account');
    return {url:url.toString(),expiresInSeconds:600,privateRcloneAvailable:false};
  }

  async complete(state: string, code: string) {
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(state) ||
        typeof code !== 'string' || code.length < 3 || code.length > 4096 ||
        /[\x00-\x1f]/.test(code)) throw new Error('PRIVATE_OWNER_LINK_CALLBACK_INVALID');
    const cfg = this.settings();
    const digest = createHash('sha256').update(state).digest('hex');
    const row = await this.db().query('DELETE FROM nyx_private_owner_link_states_v1 ' +
      'WHERE digest=$1 AND expires_at>now() RETURNING mcp_subject,encrypted_challenge', [digest]);
    if (row.rowCount !== 1 || row.rows[0].mcp_subject !== cfg.subject) {
      throw new Error('PRIVATE_OWNER_LINK_STATE_EXPIRED');
    }
    const {verifier,nonce} = this.open(digest,row.rows[0].encrypted_challenge);
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:cfg.clientId,client_secret:cfg.clientSecret,
        code,code_verifier:verifier,grant_type:'authorization_code',
        redirect_uri:cfg.publicUrl+'/connect/private-owner/callback',
      }),signal:AbortSignal.timeout(15000),
    });
    const raw = await tokenResponse.text();
    if (!tokenResponse.ok || raw.length > 32768) throw new Error('PRIVATE_OWNER_LINK_PROVIDER_ERROR');
    let identityToken: unknown;
    try { identityToken = (JSON.parse(raw) as {id_token?: unknown}).id_token; }
    catch { throw new Error('PRIVATE_OWNER_LINK_PROVIDER_ERROR'); }
    if (typeof identityToken !== 'string') throw new Error('PRIVATE_OWNER_LINK_PROVIDER_ERROR');
    const identity = await this.verifier.verify(identityToken,{clientId:cfg.clientId,nonce});
    if (!identity.emailVerified || identity.email !== cfg.email) {
      throw new Error('PRIVATE_OWNER_LINK_GOOGLE_IDENTITY_DENIED');
    }
    // Singleton upsert cannot transfer ownership: changing either immutable
    // subject requires an operator-controlled revocation/migration.
    const saved = await this.db().query('INSERT INTO nyx_private_owner_links_v1 ' +
      '(id,mcp_issuer,mcp_subject,google_subject,google_email) VALUES (1,$1,$2,$3,$4) ' +
      'ON CONFLICT (id) DO UPDATE SET linked_at=now() ' +
      'WHERE nyx_private_owner_links_v1.mcp_issuer=EXCLUDED.mcp_issuer ' +
      'AND nyx_private_owner_links_v1.mcp_subject=EXCLUDED.mcp_subject ' +
      'AND nyx_private_owner_links_v1.google_subject=EXCLUDED.google_subject ' +
      'AND nyx_private_owner_links_v1.google_email=EXCLUDED.google_email RETURNING id',
      [cfg.issuer,cfg.subject,identity.subject,identity.email]);
    if (saved.rowCount !== 1) throw new Error('PRIVATE_OWNER_LINK_CONFLICT');
    return {status:'identity_linked',privateRcloneAvailable:false};
  }
}
