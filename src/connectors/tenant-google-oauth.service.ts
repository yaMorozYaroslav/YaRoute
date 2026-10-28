import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectorsService } from './connectors.service';
import { TenantRcloneService } from './tenant-rclone.service';

const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const OPENID_SCOPES = 'openid email';
type GoogleTokenResponse = {
  access_token?: string; refresh_token?: string; token_type?: string;
  expires_in?: number; scope?: string;
};
type GoogleUserInfo = { sub?: string; email?: string; email_verified?: boolean };

function oauthBase() {
  const value = process.env.NYX_PUBLIC_URL || '';
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(value)) {
    throw new Error('TENANT_GOOGLE_PUBLIC_URL_INVALID');
  }
  return value.replace(/\/$/, '');
}
function oauthClient() {
  const id = process.env.NYX_GOOGLE_CLIENT_ID || '';
  const secret = process.env.NYX_GOOGLE_CLIENT_SECRET || '';
  if (!/^[A-Za-z0-9_.-]{10,256}$/.test(id) || !secret || secret.length > 512) {
    throw new Error('TENANT_GOOGLE_OAUTH_NOT_CONFIGURED');
  }
  return {id, secret};
}

/** Private, tenant-bound Google authorization code + PKCE, no tokens in MCP. */
@Injectable()
export class TenantGoogleOAuthService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private key?: Buffer;
  constructor(private readonly connectors: ConnectorsService,
              private readonly storage: TenantRcloneService) {}

  async onModuleInit() {
    if (process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true') return;
    if (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true') {
      throw new Error('TENANT_GOOGLE_PUBLIC_ISOLATION_REQUIRED');
    }
    const encoded = process.env.NYX_STORAGE_ENCRYPTION_KEY || '';
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
        key.length !== 32 || key.toString('base64') !== encoded ||
        !process.env.DATABASE_URL) throw new Error('TENANT_GOOGLE_VAULT_UNAVAILABLE');
    this.key = key;
    this.pool = new Pool({connectionString: process.env.DATABASE_URL, max: 3});
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_rclone_google_oauth_states_v2 (' +
      'digest text PRIMARY KEY, owner_id text NOT NULL, connection_id text NOT NULL,' +
      'folder_id text NOT NULL, encrypted_verifier text NOT NULL,' +
      'expires_at timestamptz NOT NULL)');
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private db() {
    if (!this.pool || !this.key) throw new Error('TENANT_GOOGLE_NOT_ENABLED');
    return this.pool;
  }
  private encryptVerifier(digest: string, secret: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key!, nonce);
    cipher.setAAD(Buffer.from(digest));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  private decryptVerifier(digest: string, sealed: string): string {
    const data = Buffer.from(sealed, 'base64');
    if (data.length < 29) throw new Error('TENANT_GOOGLE_AUTH_STATE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.key!, data.subarray(0,12));
    decipher.setAAD(Buffer.from(digest));
    decipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
  }

  async begin(ownerId: string, connectionId: string, folderId: string) {
    const {id} = oauthClient();
    const origin = oauthBase();
    this.db();
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(folderId)) {
      throw new Error('TENANT_GOOGLE_ROOT_INVALID');
    }
    const item = await this.connectors.getOwned(ownerId, connectionId);
    if (item.provider !== 'google-drive' || item.status === 'revoked' ||
        !(item.resources || []).some(r => r.kind === 'drive' && r.id === folderId &&
          Array.isArray(r.capabilities) && r.capabilities.includes('storage:list'))) {
      throw new Error('TENANT_GOOGLE_ROOT_NOT_SELECTED');
    }
    const state = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(state).digest('hex');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.db().query('DELETE FROM nyx_rclone_google_oauth_states_v2 ' +
      'WHERE owner_id=$1 AND connection_id=$2', [ownerId,connectionId]);
    await this.db().query('INSERT INTO nyx_rclone_google_oauth_states_v2 ' +
      '(digest,owner_id,connection_id,folder_id,encrypted_verifier,expires_at) ' +
      "VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes')",
      [digest,ownerId,connectionId,folderId,this.encryptVerifier(digest,verifier)]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', id);
    url.searchParams.set('redirect_uri', origin + '/connect/google/callback');
    url.searchParams.set('scope', DRIVE_READ_SCOPE + ' ' + OPENID_SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('include_granted_scopes', 'false');
    return {url:url.toString(),expiresInSeconds:600,
      message:'Open the Google authorization URL yourself. Only read-only Drive consent is requested; existing remotes are not changed.'};
  }

  private async readSmallJson<T>(response: Response): Promise<T> {
    const content = await response.text();
    if (!response.ok || content.length > 32768) throw new Error('TENANT_GOOGLE_PROVIDER_ERROR');
    try { return JSON.parse(content) as T; }
    catch { throw new Error('TENANT_GOOGLE_PROVIDER_ERROR'); }
  }

  /** Public HTTPS callback; only a one-time stored state identifies the owner. */
  async complete(state: string, code: string) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(state) ||
        typeof code !== 'string' || code.length < 3 || code.length > 4096 ||
        /[\x00-\x1f]/.test(code)) {
      throw new Error('TENANT_GOOGLE_CALLBACK_INVALID');
    }
    const {id,secret} = oauthClient();
    const digest = createHash('sha256').update(state).digest('hex');
    const row = await this.db().query('DELETE FROM nyx_rclone_google_oauth_states_v2 ' +
      'WHERE digest=$1 AND expires_at>now() RETURNING owner_id,connection_id,folder_id,encrypted_verifier',
      [digest]);
    if (row.rowCount !== 1) throw new Error('TENANT_GOOGLE_AUTH_STATE_EXPIRED');
    const {owner_id:ownerId,connection_id:connectionId,folder_id:folderId,
      encrypted_verifier:encryptedVerifier} = row.rows[0];
    const verifier = this.decryptVerifier(digest, encryptedVerifier);
    const item = await this.connectors.getOwned(ownerId, connectionId);
    if (item.provider !== 'google-drive' || item.status === 'revoked' ||
        !(item.resources || []).some(r => r.kind === 'drive' && r.id === folderId &&
          r.capabilities.includes('storage:list'))) {
      throw new Error('TENANT_GOOGLE_CONNECTION_CHANGED');
    }
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:id,client_secret:secret,
        code,code_verifier:verifier,grant_type:'authorization_code',
        redirect_uri:oauthBase()+'/connect/google/callback',
      }),
      signal:AbortSignal.timeout(15000),
    });
    const token = await this.readSmallJson<GoogleTokenResponse>(tokenResponse);
    const granted = new Set((token.scope || '').split(/\s+/));
    if (!token.access_token || !token.refresh_token || token.token_type?.toLowerCase() !== 'bearer' ||
        !token.expires_in || !Number.isFinite(token.expires_in) ||
        !granted.has(DRIVE_READ_SCOPE) || !granted.has('openid')) {
      throw new Error('TENANT_GOOGLE_SCOPE_OR_REFRESH_TOKEN_REQUIRED');
    }
    const identityResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers:{authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(15000),
    });
    const account = await this.readSmallJson<GoogleUserInfo>(identityResponse);
    if (!account.sub || !/^[0-9A-Za-z_-]{1,256}$/.test(account.sub)) {
      throw new Error('TENANT_GOOGLE_ACCOUNT_UNVERIFIED');
    }
    if (item.status === 'active' && item.externalAccountId !== account.sub) {
      throw new Error('TENANT_RCLONE_ACCOUNT_CHANGE_FORBIDDEN');
    }
    const expires = new Date(Date.now()+Math.floor(token.expires_in)*1000);
    const profile = {provider:'google-drive' as const,
      rootFolderId:folderId,scope:'drive.readonly' as const, clientId:id,
      clientSecret:secret,
      token:JSON.stringify({
        access_token:token.access_token,token_type:'Bearer',
        refresh_token:token.refresh_token,expiry:expires.toISOString(),
      }),
    };
    // Only callback-attested provider credentials reach the isolated pending V2 vault.
    await this.storage.stageCredential(ownerId,connectionId,profile);
    await this.connectors.confirmStorageProvider(ownerId,connectionId,'google-drive',account.sub);
    return {status:'pending_read_probe',provider:'google-drive'};
  }
}
