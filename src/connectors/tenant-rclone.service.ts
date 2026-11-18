import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { assertPublicTenantGoogleOwnerId, assertPublicTenantStorageProvider } from './public-tenant-provider.policy';
import { ConnectorsService } from './connectors.service';
import { verifyImportedGoogleIdentity } from './imported-google-identity';
import { refreshedGoogleFromIsolatedConfig } from './rclone-google-token-refresh';
import {selectVerifiedStorageConnection} from './storage-connection-selector';

export type TenantRcloneProvider = 'google-drive' | 'mega';
export type TenantRcloneProfile =
  | { provider: 'google-drive'; token: string; clientId?: string;
      clientSecret?: string; rootFolderId?: string; teamDriveId?: string;
      /** Legacy account root: omit root_folder_id option without relaxing the logical root grant. */
      accountRoot?: boolean;
      scope?: 'drive.readonly' | 'drive.file' | 'drive' }
  | { provider: 'mega'; user: string; obscuredPassword: string;
      sessionId?: string; masterKey?: string;
      /** Assigned only after successfully probing this exact root. */
      verifiedRoot?: string;
      /** Only used for one login probe; forbidden in encrypted vault rows. */
      transientTwoFactorCode?: string };

export type ReadProbeResult = 'verified' | 'failed' | 'timeout';

function safeLine(value: string, max = 32768): string {
  if (typeof value !== 'string' || !value.length || value.length > max ||
      /[\x00\r\n]/.test(value)) throw new Error('TENANT_RCLONE_PROFILE_INVALID');
  return value;
}

/** Construct one single remote; no caller-controlled section names, config paths or options. */
export function tenantRcloneConfig(profile: TenantRcloneProfile): string {
  if (profile.provider === 'google-drive') {
    if (!profile.rootFolderId) throw new Error('TENANT_RCLONE_ROOT_REQUIRED');
    const token = safeLine(profile.token);
    let parsed: unknown;
    try { parsed = JSON.parse(token); } catch { throw new Error('TENANT_RCLONE_PROFILE_INVALID'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('TENANT_RCLONE_PROFILE_INVALID');
    }
    const lines = ['[tenant]', 'type = drive', 'token = ' + token];
    if (profile.clientId) lines.push('client_id = ' + safeLine(profile.clientId, 2048));
    if (profile.clientSecret) lines.push('client_secret = ' + safeLine(profile.clientSecret, 2048));
    if (profile.accountRoot !== undefined &&
        (profile.accountRoot !== true || profile.rootFolderId !== 'root')) {
      throw new Error('TENANT_RCLONE_ACCOUNT_ROOT_INVALID');
    }
    if (!profile.accountRoot && profile.rootFolderId)
      lines.push('root_folder_id = ' + safeLine(profile.rootFolderId, 2048));
    if (profile.teamDriveId !== undefined) {
      if (typeof profile.teamDriveId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(profile.teamDriveId)) {
        throw new Error('TENANT_RCLONE_TEAM_DRIVE_INVALID');
      }
      lines.push('team_drive = ' + profile.teamDriveId);
    }
    if (profile.scope) {
      if (!['drive', 'drive.file', 'drive.readonly'].includes(profile.scope)) {
        throw new Error('TENANT_RCLONE_PROFILE_INVALID');
      }
      lines.push('scope = ' + profile.scope);
    }
    return lines.join('\n') + '\n';
  }
  if (profile.provider === 'mega') {
    if (Boolean(profile.sessionId) !== Boolean(profile.masterKey)) {
      throw new Error('TENANT_MEGA_SESSION_INCOMPLETE');
    }
    if (profile.transientTwoFactorCode !== undefined &&
        !/^[0-9]{6}$/.test(profile.transientTwoFactorCode)) {
      throw new Error('TENANT_MEGA_2FA_INVALID');
    }
    const opts = ['[tenant]', 'type = mega',
      'user = ' + safeLine(profile.user, 512),
      // Obscuring is not encryption: the stored profile must remain AES-GCM sealed.
      'pass = ' + safeLine(profile.obscuredPassword, 8192)];
    if (profile.sessionId) {
      opts.push('session_id = ' + safeLine(profile.sessionId, 4096));
      opts.push('master_key = ' + safeLine(profile.masterKey!, 4096));
    }
    if (profile.transientTwoFactorCode) opts.push('2fa = ' + profile.transientTwoFactorCode);
    return opts.concat('').join('\n');
  }
  throw new Error('TENANT_RCLONE_PROVIDER_UNSUPPORTED');
}

/** A provider-relative path may never switch remote or climb outside the granted root. */
export function tenantRclonePath(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 ||
      value.startsWith('/') || /[:\\\x00-\x1f]/.test(value) ||
      value.split('/').some((component) => component === '..')) {
    throw new Error('TENANT_RCLONE_PATH_INVALID');
  }
  const result = path.posix.normalize(value || '.');
  if (result === '..' || result.startsWith('../') || result.startsWith('/')) {
    throw new Error('TENANT_RCLONE_PATH_INVALID');
  }
  return result === '.' ? '' : result;
}

/**
 * Independent opt-in V2 storage authorization, deliberately separate from legacy
 * RCLONE_CONFIG_B64, RCLONE_CONFIG_PATH, SharedRootsService and fixed storage slots.
 * No endpoint registers credentials; only a future verified server-side provider
 * callback may invoke stageCredential. The public connection UI remains GitHub-only.
 */
@Injectable()
export class TenantRcloneService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private encryptionKey?: Buffer;
  private readonly binary = process.env.RCLONE_BINARY || path.resolve('.bin/rclone');

  constructor(private readonly connectors: ConnectorsService) {}

  async onModuleInit() {
    if (process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true') return;
    if (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true') {
      throw new Error('TENANT_RCLONE_REQUIRES_PUBLIC_CONNECTOR_ISOLATION');
    }
    // A public tenant runtime must NOT carry any legacy private operator storage
    // configuration. Keep the existing private Rclone app online in PARALLEL;
    // never migrate by mixing secrets into one public tenant process.
    if (['RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH','RCLONE_CONFIG',
         'NYX_SHARED_ROOTS_JSON'].some(name => Boolean(process.env[name]?.trim()))) {
      throw new Error('TENANT_RCLONE_PRIVATE_CONFIG_PRESENT');
    }
    const encoded = process.env.NYX_STORAGE_ENCRYPTION_KEY || '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || !process.env.DATABASE_URL) {
      throw new Error('TENANT_RCLONE_VAULT_UNAVAILABLE');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error('TENANT_RCLONE_VAULT_UNAVAILABLE');
    }
    this.encryptionKey = key;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_rclone_tenant_credentials_v2 (
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      provider text NOT NULL CHECK (provider IN ('google-drive', 'mega')),
      encrypted_profile text NOT NULL,
      state text NOT NULL CHECK (state IN ('pending', 'active')),
      read_verified_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, connection_id, state)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_rclone_google_mutations_v1 (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      root_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('rename','move','trash')),
      source_path text NOT NULL,
      destination_path text,
      state text NOT NULL CHECK (state IN ('running','verified','uncertain')),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_rclone_tenant_creations_v1 (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      root_id text NOT NULL,
      provider text NOT NULL CHECK (provider IN ('google-drive','mega')),
      target_path text NOT NULL,
      state text NOT NULL CHECK (state IN ('running','verified','uncertain')),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )`);
    // Durable receipts: an interrupted operation remains "running" for reconciliation.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_rclone_mega_mutations_v1 (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      root_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('rename','move','trash')),
      source_path text NOT NULL,
      destination_path text,
      state text NOT NULL CHECK (state IN ('running','verified','uncertain')),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )`);
  }

  async onModuleDestroy() { await this.pool?.end(); }

  private db(): Pool {
    if (!this.pool || !this.encryptionKey) throw new Error('TENANT_RCLONE_NOT_ENABLED');
    return this.pool;
  }

  private owner(ownerId: string, connectionId: string) {
    assertPublicTenantGoogleOwnerId(ownerId);
    if (typeof ownerId !== 'string' || !/^oauth:[^\x00-\x1f]{1,500}$/.test(ownerId) ||
        typeof connectionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(connectionId)) {
      throw new Error('TENANT_RCLONE_IDENTITY_REQUIRED');
    }
  }

  private async owned(ownerId: string, connectionId: string, provider?: TenantRcloneProvider,
                      allowRevokeOnly = false) {
    this.owner(ownerId, connectionId);
    const item = await this.connectors.getOwned(ownerId, connectionId).catch(() => undefined);
    if (!item || item.status === 'revoked' ||
        !['google-drive', 'mega'].includes(item.provider) ||
        (provider && provider !== item.provider)) {
      throw new Error('TENANT_RCLONE_CONNECTION_FORBIDDEN');
    }
    // Existing Google tenant records may be revoked after switching to
    // MEGA-only, but never probed, staged, activated or listed.
    if (!allowRevokeOnly) assertPublicTenantStorageProvider(item.provider);
    return item;
  }

  private seal(ownerId: string, connectionId: string, profile: TenantRcloneProfile): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey!, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([ownerId, connectionId, profile.provider, 'v2'])));
    const payload = Buffer.concat([cipher.update(JSON.stringify(profile), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
  }

  private open(ownerId: string, connectionId: string, provider: TenantRcloneProvider,
               packed: string): TenantRcloneProfile {
    const bytes = Buffer.from(packed, 'base64');
    if (bytes.length < 29) throw new Error('TENANT_RCLONE_CREDENTIAL_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey!, bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(JSON.stringify([ownerId, connectionId, provider, 'v2'])));
    decipher.setAuthTag(bytes.subarray(12,28));
    const profile = JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString('utf8')) as TenantRcloneProfile;
    if (profile.provider !== provider) throw new Error('TENANT_RCLONE_PROVIDER_MISMATCH');
    tenantRcloneConfig(profile);
    return profile;
  }

  /**
   * Trusted internal handoff ONLY: after independently verified provider sign-in.
   * Never expose this method directly through MCP/HTTP and never accept ownerId
   * or raw credentials from model-generated arguments.
   */
  /**
   * Safe batch retry: stage only when no pending ciphertext and no provider
   * identity proof exist. Never replace a pending OAuth/MEGA enrollment.
   */
  async stageImportedCredentialIfAbsent(ownerId:string,connectionId:string,
                                         profile:TenantRcloneProfile) {
    const item=await this.owned(ownerId,connectionId,profile.provider);
    if(item.status!=='pending'||item.externalAccountId!=='pending')
      throw new Error('TENANT_IMPORT_PENDING_CONNECTION_REQUIRED');
    if(profile.provider==='mega' &&
       (profile.transientTwoFactorCode!==undefined||
        profile.verifiedRoot!==undefined))
      throw new Error('TENANT_IMPORT_TRANSIENT_MEGA_FIELD_FORBIDDEN');
    tenantRcloneConfig(profile);
    const packed=this.seal(ownerId,connectionId,profile);
    const saved=await this.db().query(
      'INSERT INTO nyx_rclone_tenant_credentials_v2 '+
      '(owner_id,connection_id,provider,encrypted_profile,state) '+
      "SELECT $1,$2,$3,$4,'pending' "+
      'WHERE NOT EXISTS (SELECT 1 FROM nyx_storage_verified_identity_v1 '+
      'WHERE owner_id=$1 AND connection_id=$2) '+
      'AND NOT EXISTS (SELECT 1 FROM nyx_rclone_tenant_credentials_v2 ' +
      'WHERE owner_id=$1 AND connection_id=$2) ' +
      'ON CONFLICT (owner_id,connection_id,state) DO NOTHING '+
      'RETURNING connection_id',
      [ownerId,connectionId,profile.provider,packed]);
    return {staged:saved.rowCount===1};
  }

  async stageCredential(ownerId: string, connectionId: string, profile: TenantRcloneProfile) {
    const item = await this.owned(ownerId, connectionId, profile.provider);
    if (item.status === 'revoked') throw new Error('TENANT_RCLONE_CONNECTION_FORBIDDEN');
    // One-time MEGA codes must NEVER enter durable database records.
    if (profile.provider === 'mega' && profile.transientTwoFactorCode !== undefined)
      throw new Error('TENANT_MEGA_2FA_PERSISTENCE_FORBIDDEN');
    if (profile.provider === 'mega' && profile.verifiedRoot !== undefined)
      throw new Error('TENANT_MEGA_VERIFICATION_SERVER_ONLY');
    tenantRcloneConfig(profile);
    const packed = this.seal(ownerId, connectionId, profile);
    await this.db().query(`INSERT INTO nyx_rclone_tenant_credentials_v2
      (owner_id, connection_id, provider, encrypted_profile, state)
      VALUES ($1,$2,$3,$4,'pending')
      ON CONFLICT (owner_id, connection_id, state) DO UPDATE SET
        provider=EXCLUDED.provider, encrypted_profile=EXCLUDED.encrypted_profile,
        read_verified_at=NULL, updated_at=now()`,
      [ownerId, connectionId, profile.provider, packed]);
    return { status: 'pending_read_probe' as const, connectionId };
  }

  private async profile(ownerId: string, connectionId: string, state: 'pending'|'active') {
    const r = await this.db().query(
      `SELECT provider, encrypted_profile FROM nyx_rclone_tenant_credentials_v2
        WHERE owner_id=$1 AND connection_id=$2 AND state=$3`,
      [ownerId, connectionId, state]);
    if (!r.rowCount) throw new Error('TENANT_RCLONE_CREDENTIAL_NOT_AVAILABLE');
    const provider = r.rows[0].provider as TenantRcloneProvider;
    const profile = this.open(ownerId, connectionId, provider, r.rows[0].encrypted_profile);
    return { provider, profile, packed: r.rows[0].encrypted_profile as string };
  }

  /**
   * Read-only credential verification must target the exact selected root.
   * Verifying an account root does not establish that a user-selected subfolder
   * exists or is readable. Fail closed on ambiguous MEGA root grants.
   */
  async probePending(ownerId: string, connectionId: string,
                     expectedMegaRoot?: string, oneTimeMegaCode?: string): Promise<ReadProbeResult> {
    const item = await this.owned(ownerId, connectionId);
    const candidate = await this.profile(ownerId, connectionId, 'pending');
    if (candidate.provider !== item.provider)
      throw new Error('TENANT_RCLONE_PROVIDER_MISMATCH');
    let relativePath = '';
    if (candidate.provider === 'mega') {
      const roots = (item.resources || []).filter(r =>
        r.kind === 'mega-root' && r.capabilities.includes('storage:list'));
      if (roots.length !== 1 || typeof roots[0].id !== 'string')
        throw new Error('TENANT_MEGA_EXACT_ROOT_REQUIRED');
      if (expectedMegaRoot !== undefined && expectedMegaRoot !== roots[0].id)
        throw new Error('TENANT_MEGA_SELECTED_ROOT_CHANGED');
      relativePath = roots[0].id === 'MEGA_ROOT' ? '' : tenantRclonePath(roots[0].id);
    } else if (expectedMegaRoot !== undefined) {
      throw new Error('TENANT_MEGA_EXPECTED_PROVIDER_INVALID');
    }
    if (oneTimeMegaCode !== undefined &&
        (candidate.provider !== 'mega' || !/^[0-9]{6}$/.test(oneTimeMegaCode)))
      throw new Error('TENANT_MEGA_2FA_INVALID');
    let refreshedProfile: TenantRcloneProfile | undefined;
    const loginProfile: TenantRcloneProfile = oneTimeMegaCode &&
      candidate.profile.provider === 'mega'
      ? {...candidate.profile, transientTwoFactorCode:oneTimeMegaCode}
      : candidate.profile;
    const status = await this.probe(loginProfile, relativePath,
      oneTimeMegaCode ? async configPath => {
        // Rclone may save a reusable authenticated MEGA session back into its
        // private temporary config. Read it only after successful probe; reject
        // MFA enrollment if credentials cannot be made durable without the OTP.
        const raw = await fs.readFile(configPath,'utf8');
        const lines=raw.split(/\r?\n/);
        const start=lines.findIndex(line=>line.trim()==='[tenant]');
        if (start<0) return false;
        const fields=new Map<string,string>();
        for (const line of lines.slice(start+1)) {
          if (/^\[/.test(line)) break;
          const match=line.match(/^([a-z_]+)\s*=\s*(.+)$/);
          if (match) fields.set(match[1],match[2].trim());
        }
        const sessionId=fields.get('session_id');
        const masterKey=fields.get('master_key');
        if (!sessionId || !masterKey || sessionId.length>4096 ||
            !/^[A-Za-z0-9+/=_-]{16,4096}$/.test(masterKey)) return false;
        refreshedProfile={provider:'mega',user:candidate.profile.provider==='mega'
          ? candidate.profile.user : '',obscuredPassword:candidate.profile.provider==='mega'
          ? candidate.profile.obscuredPassword : '',sessionId,masterKey};
        tenantRcloneConfig(refreshedProfile);
        return true;
      } : candidate.profile.provider==='google-drive' ? async configPath => {
        // Token refresh is captured from the exact successful isolated Rclone
        // config, not from the provider/API response or untrusted user input.
        const contents=await fs.readFile(configPath,'utf8');
        const updated=refreshedGoogleFromIsolatedConfig(
          candidate.profile as Extract<TenantRcloneProfile,{provider:'google-drive'}>,contents);
        if(updated)refreshedProfile=updated;
        return true;
      } : undefined);
    if (status === 'verified' && oneTimeMegaCode && !refreshedProfile)
      return 'failed';
    if (status === 'verified') {
      // Import uses exactly the same server-attested, owner-scoped namespace
      // dedupe as OAuth sign-in. Never infer an identity from the import
      // manifest or merely from the local remote display name.
      // For MEGA, a successful authenticated login to an exact root verifies
      // the account email the MEGA client used. For Google, ask the provider
      // directly for its stable user/Drive identity.
      if(item.externalAccountId==='pending'){
        try{
          if(candidate.profile.provider==='google-drive'){
            const profileForIdentity=refreshedProfile?.provider==='google-drive'
              ? refreshedProfile : candidate.profile;
            const proof=await verifyImportedGoogleIdentity(profileForIdentity);
            await this.connectors.attestImportedPendingStorageIdentity(
              ownerId,connectionId,'google-drive',proof.accountId,proof.driveId);
          }else if(candidate.profile.provider==='mega'){
            await this.connectors.attestImportedPendingStorageIdentity(
              ownerId,connectionId,'mega',candidate.profile.user);
          }
        }catch{
          // No verification receipt or read_verified_at for an unproven
          // namespace. Preserve the pending encrypted credentials for retry.
          return 'failed';
        }
      }
      // Replace a one-time 2FA code with reusable, encrypted session keys.
      // Never retain the OTP in a pending or active credential row.
      const durableProfile = refreshedProfile || candidate.profile;
      const verifiedProfile: TenantRcloneProfile = durableProfile.provider === 'mega'
        ? {...durableProfile, verifiedRoot: relativePath || 'MEGA_ROOT'} : durableProfile;
      const packed = verifiedProfile.provider === 'mega' || refreshedProfile
        ? this.seal(ownerId, connectionId, verifiedProfile) : candidate.packed;
      const updated = await this.db().query(`UPDATE nyx_rclone_tenant_credentials_v2 SET
          encrypted_profile=$4, read_verified_at=now()
          WHERE owner_id=$1 AND connection_id=$2
          AND state='pending' AND encrypted_profile=$3`,
        [ownerId, connectionId, candidate.packed, packed]);
      if (updated.rowCount!==1) return 'failed';
    }
    return status;
  }

  /**
   * Complete a newly imported, server-attested, freshly read-verified profile.
   * This grants storage:list only; no operator-owned secrets or write grants.
   * Metadata and ciphertext promotion commit together in one transaction.
   */
  async activateImportedReadOnly(ownerId:string, connectionId:string) {
    const owned=await this.owned(ownerId,connectionId);
    if(owned.provider!=='mega' && owned.provider!=='google-drive')
      throw new Error('TENANT_IMPORT_PROVIDER_FORBIDDEN');
    if(owned.status!=='pending')throw new Error('TENANT_IMPORT_NOT_PENDING');
    const client=await this.db().connect();
    let begun=false;
    try {
      await client.query('BEGIN');begun=true;
      const m=await client.query(
        'SELECT provider,status,external_account_id,capabilities,'+
        'provider_capabilities,resources FROM nyx_connector_connections '+
        'WHERE owner_id=$1 AND id=$2 FOR UPDATE',[ownerId,connectionId]);
      if(m.rowCount!==1||m.rows[0].status!=='pending'||
         m.rows[0].external_account_id!=='pending'||
         m.rows[0].provider!==owned.provider)
        throw new Error('TENANT_IMPORT_METADATA_CHANGED');
      const meta=m.rows[0];
      const caps=typeof meta.capabilities==='string'?
        JSON.parse(meta.capabilities):meta.capabilities;
      const providerCaps=typeof meta.provider_capabilities==='string'?
        JSON.parse(meta.provider_capabilities):meta.provider_capabilities;
      const roots=typeof meta.resources==='string'?JSON.parse(meta.resources):meta.resources;
      if(!Array.isArray(caps)||caps.length!==1||caps[0]!=='storage:list'||
         !Array.isArray(providerCaps)||providerCaps.length!==0||
         !Array.isArray(roots)||roots.length!==1||
         roots[0].kind!==(owned.provider==='mega'?'mega-root':'drive')||
         !Array.isArray(roots[0].capabilities)||
         roots[0].capabilities.length!==1||
         roots[0].capabilities[0]!=='storage:list')
        throw new Error('TENANT_IMPORT_READ_GRANTS_CHANGED');
      const proof=await client.query(
        'SELECT provider,namespace,external_id FROM nyx_storage_verified_identity_v1 '+
        'WHERE owner_id=$1 AND connection_id=$2 FOR UPDATE',[ownerId,connectionId]);
      if(proof.rowCount!==1||proof.rows[0].provider!==owned.provider||
         typeof proof.rows[0].namespace!=='string'||
         typeof proof.rows[0].external_id!=='string'||
         !proof.rows[0].namespace||!proof.rows[0].external_id)
        throw new Error('TENANT_IMPORT_PROVIDER_ATTESTATION_REQUIRED');
      const pending=await client.query(
        'SELECT provider,encrypted_profile FROM nyx_rclone_tenant_credentials_v2 '+
        'WHERE owner_id=$1 AND connection_id=$2 AND state=$3 '+
        "AND read_verified_at>now()-interval '15 minutes' FOR UPDATE",
        [ownerId,connectionId,'pending']);
      if(pending.rowCount!==1||pending.rows[0].provider!==owned.provider)
        throw new Error('TENANT_IMPORT_FRESH_READ_REQUIRED');
      const profile=this.open(ownerId,connectionId,owned.provider,
        pending.rows[0].encrypted_profile as string);
      if(profile.provider==='google-drive') {
        if(roots[0].id!==profile.rootFolderId||
           !(proof.rows[0].namespace.startsWith('my-drive:')||
             proof.rows[0].namespace.startsWith('shared-drive:')))
          throw new Error('TENANT_IMPORT_GOOGLE_ROOT_CHANGED');
      } else if(profile.provider==='mega') {
        if(roots[0].id!==profile.verifiedRoot||
           (roots[0].id!=='MEGA_ROOT' &&
            roots[0].id!==tenantRclonePath(roots[0].id)))
          throw new Error('TENANT_IMPORT_MEGA_ROOT_CHANGED');
      }
      const active=await client.query(
        "SELECT connection_id FROM nyx_rclone_tenant_credentials_v2 "+
        "WHERE owner_id=$1 AND connection_id=$2 AND state='active' FOR UPDATE",
        [ownerId,connectionId]);
      if(active.rowCount!==0)throw new Error('TENANT_IMPORT_ACTIVE_ALREADY_PRESENT');
      const metadata=await client.query(
        "UPDATE nyx_connector_connections SET status='active',"+
        "external_account_id=$3,provider_capabilities='[\"storage:list\"]'::jsonb,"+
        "updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='pending' "+
        "AND external_account_id='pending' RETURNING id",
        [ownerId,connectionId,proof.rows[0].external_id]);
      if(metadata.rowCount!==1)throw new Error('TENANT_IMPORT_METADATA_RACE');
      const promoted=await client.query(
        "UPDATE nyx_rclone_tenant_credentials_v2 SET state='active',updated_at=now() "+
        "WHERE owner_id=$1 AND connection_id=$2 AND state='pending' "+
        "AND read_verified_at>now()-interval '15 minutes' RETURNING connection_id",
        [ownerId,connectionId]);
      if(promoted.rowCount!==1)throw new Error('TENANT_IMPORT_CREDENTIAL_RACE');
      await client.query('COMMIT');begun=false;
      return {status:'active' as const,connectionId,provider:owned.provider,
        capabilities:['storage:list'] as const};
    }catch(error) {
      if(begun)await client.query('ROLLBACK').catch(()=>{});
      throw error;
    }finally{client.release();}
  }

  /** Requires independent provider grant AND successful recent read probe. */
  async activate(ownerId: string, connectionId: string) {
    const owner = await this.owned(ownerId, connectionId);
    const pendingCandidate = await this.profile(ownerId, connectionId, 'pending');
    const rootId = pendingCandidate.profile.provider === 'google-drive'
      ? pendingCandidate.profile.rootFolderId : undefined;
    const kind = pendingCandidate.provider === 'mega' ? 'mega-root' : 'drive';
    if (pendingCandidate.profile.provider === 'mega') {
      const roots = (owner.resources || []).filter(r => r.kind === 'mega-root' &&
        r.capabilities.includes('storage:list'));
      if (roots.length !== 1 || !pendingCandidate.profile.verifiedRoot ||
          pendingCandidate.profile.verifiedRoot !==
            (roots[0].id === 'MEGA_ROOT' ? 'MEGA_ROOT' : tenantRclonePath(roots[0].id))) {
        throw new Error('TENANT_MEGA_VERIFIED_ROOT_CHANGED');
      }
    }
    if (pendingCandidate.provider !== owner.provider ||
        !(owner.resources || []).some(r => r.kind === kind &&
          (kind === 'mega-root' || r.id === rootId) &&
          r.capabilities.includes('storage:list'))) {
      throw new Error('TENANT_RCLONE_RESOURCE_FORBIDDEN');
    }
    const grant = await this.connectors.registryPolicy().require(ownerId, connectionId, 'storage:list');
    if (!['google-drive','mega'].includes(grant.provider)) {
      throw new Error('TENANT_RCLONE_PROVIDER_MISMATCH');
    }
    const client = await this.db().connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(`SELECT connection_id FROM nyx_rclone_tenant_credentials_v2
        WHERE owner_id=$1 AND connection_id=$2 AND provider=$3
          AND state='pending' AND read_verified_at > now() - interval '15 minutes'
          AND encrypted_profile=$4
        FOR UPDATE`, [ownerId, connectionId, grant.provider, pendingCandidate.packed]);
      if (!pending.rowCount) throw new Error('TENANT_RCLONE_VERIFICATION_REQUIRED');
      // Preserve the active V2 credentials until the staged candidate is verified;
      // switch both rows in one transaction, rolling back if promotion fails.
      await client.query(`DELETE FROM nyx_rclone_tenant_credentials_v2
        WHERE owner_id=$1 AND connection_id=$2 AND state='active'`, [ownerId, connectionId]);
      await client.query(`UPDATE nyx_rclone_tenant_credentials_v2 SET
        state='active', updated_at=now()
        WHERE owner_id=$1 AND connection_id=$2 AND state='pending'`, [ownerId, connectionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { status: 'active' as const, connectionId };
  }

  /**
   * Revoke only this OAuth owner's tenant storage connection. In one transaction,
   * disable future authorization and erase pending/active encrypted credentials
   * plus outstanding one-use enrollment states. No Rclone subprocess is invoked.
   * Provider-side token/session revocation remains the user's separate action.
   */
  async revokeStorage(ownerId: string, connectionId: string) {
    await this.owned(ownerId, connectionId, undefined, true);
    const client = await this.db().connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        "UPDATE nyx_connector_connections SET status='revoked', " +
        "capabilities='[]'::jsonb, provider_capabilities='[]'::jsonb, " +
        "resources='[]'::jsonb, updated_at=now() " +
        "WHERE owner_id=$1 AND id=$2 AND provider IN ('mega','google-drive') " +
        "AND status <> 'revoked' RETURNING id",
        [ownerId, connectionId]);
      if (updated.rowCount !== 1) throw new Error('TENANT_RCLONE_REVOKE_STALE');
      await client.query(
        'DELETE FROM nyx_rclone_tenant_credentials_v2 WHERE owner_id=$1 AND connection_id=$2',
        [ownerId, connectionId]);
      await client.query(
        'DELETE FROM nyx_rclone_mega_enroll_states_v2 WHERE owner_id=$1 AND connection_id=$2',
        [ownerId, connectionId]);
      await client.query(
        'DELETE FROM nyx_rclone_google_oauth_states_v2 WHERE owner_id=$1 AND connection_id=$2',
        [ownerId, connectionId]);
      await client.query(
        'DELETE FROM nyx_storage_verified_identity_v1 WHERE owner_id=$1 AND connection_id=$2',
        [ownerId, connectionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return {id:connectionId,status:'revoked' as const,
      localCredentialsDeleted:true, externalRevocationRequired:true};
  }

  /** Resolve a single authenticated connection + exact grant before any subprocess. */
  private async authorizedTarget(ownerId: string, connectionId: string,
                                 provider: TenantRcloneProvider, resourceId: string,
                                 relativePath: string) {
    const clean = tenantRclonePath(relativePath);
    await this.owned(ownerId, connectionId, provider);
    const authorization = await this.connectors.registryPolicy().requireResource(
      ownerId, connectionId, 'storage:list',
      {kind: provider === 'mega' ? 'mega-root' : 'drive', id: resourceId, path: clean});
    if (authorization.provider !== provider) throw new Error('TENANT_RCLONE_PROVIDER_MISMATCH');
    const active = await this.profile(ownerId, connectionId, 'active');
    if (active.provider !== provider) throw new Error('TENANT_RCLONE_PROVIDER_MISMATCH');
    if (provider === 'google-drive') {
      if (active.profile.provider !== 'google-drive' ||
          active.profile.rootFolderId !== resourceId) throw new Error('TENANT_RCLONE_ROOT_FORBIDDEN');
      return {profile:active.profile, packed:active.packed, path:clean};
    }
    const root = resourceId === 'MEGA_ROOT' ? '' : tenantRclonePath(resourceId);
    if (active.profile.provider !== 'mega' ||
        active.profile.verifiedRoot !== (root || 'MEGA_ROOT')) {
      throw new Error('TENANT_MEGA_VERIFIED_ROOT_CHANGED');
    }
    return {profile:active.profile, packed:active.packed,
      path:tenantRclonePath([root,clean].filter(Boolean).join('/'))};
  }

  /**
   * Rotate Google OAuth credentials in the same owner+connection+state row,
   * compare-and-swap only: never overwrite a newer profile or alter grants.
   * Runs ONLY after an isolated, successful Rclone operation.
   */
  private async persistActiveGoogleRefresh(
    ownerId:string,connectionId:string,
    profile:TenantRcloneProfile,packed:string,configPath:string,
  ):Promise<boolean> {
    if(profile.provider!=='google-drive')return true;
    const contents=await fs.readFile(configPath,'utf8');
    const next=refreshedGoogleFromIsolatedConfig(profile,contents);
    if(!next)return true;
    const sealed=this.seal(ownerId,connectionId,next);
    const changed=await this.db().query(
      'UPDATE nyx_rclone_tenant_credentials_v2 SET '+
      'encrypted_profile=$4, updated_at=now() '+
      "WHERE owner_id=$1 AND connection_id=$2 AND provider='google-drive' "+
      "AND state='active' AND encrypted_profile=$3 RETURNING connection_id",
      [ownerId,connectionId,packed,sealed]);
    if(changed.rowCount!==1)
      throw new Error('TENANT_GOOGLE_REFRESH_CONCURRENT_CHANGE');
    return true;
  }

  /** Read-only status; neither returns names nor touches private/global remotes. */
  async probeAuthorizedRoot(ownerId: string, connectionId: string, provider: TenantRcloneProvider,
                            resourceId: string, relativePath = ''): Promise<ReadProbeResult> {
    const target = await this.authorizedTarget(ownerId,connectionId,provider,resourceId,relativePath);
    return this.probe(target.profile,target.path,
      target.profile.provider==='google-drive'
        ? configPath=>this.persistActiveGoogleRefresh(
          ownerId,connectionId,target.profile,target.packed,configPath)
        : undefined);
  }

  /**
   * First actual per-user storage read API: list at most 100 entries at depth one.
   * Rclone runs with a unique config containing one tenant's encrypted-vault profile.
   * No shared/local Rclone configuration, inherited provider credentials, or write operations.
   */
  async listAuthorizedRoot(ownerId:string, connectionId:string, provider:TenantRcloneProvider,
                           resourceId:string, relativePath='') {
    const target=await this.authorizedTarget(ownerId,connectionId,provider,resourceId,relativePath);
    return this.listIsolated(target.profile,target.path,
      target.profile.provider==='google-drive'
        ? configPath=>this.persistActiveGoogleRefresh(
          ownerId,connectionId,target.profile,target.packed,configPath)
        : undefined);
  }


  /**
   * Opt-in, owner-authorized single-file MEGA operations.
   * Trash is the MEGA backend's *provider rubbish bin*, not a folder called Trash.
   * Never run --mega-hard-delete or rclone purge; no per-file confirmation token.
   */
  async mutateMegaFile(ownerId:string, connectionId:string, rootId:string,
    operation:'rename'|'move'|'trash', sourcePath:string, destinationPath?:string) {
    if (process.env.NYX_DEPLOYMENT_MODE!=='public' ||
        process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED!=='true')
      throw new Error('TENANT_MEGA_MUTATIONS_DISABLED');
    if (!['rename','move','trash'].includes(operation))
      throw new Error('TENANT_MEGA_OPERATION_INVALID');
    const clean=(value:string) => {
      const result=tenantRclonePath(value);
      if (!result || result!==value || value.split('/').some(part=>!part || part==='.' || part==='..'))
        throw new Error('TENANT_MEGA_FILE_PATH_INVALID');
      return result;
    };
    const source=clean(sourcePath);
    const destination=operation==='trash' ? undefined : clean(destinationPath || '');
    if (destination && destination===source)throw new Error('TENANT_MEGA_NOOP_FORBIDDEN');
    if (destination && operation==='rename' &&
        source.split('/').slice(0,-1).join('/') !== destination.split('/').slice(0,-1).join('/'))
      throw new Error('TENANT_MEGA_RENAME_PARENT_CHANGED');
    if (operation==='trash' && destinationPath!==undefined)
      throw new Error('TENANT_MEGA_TRASH_DESTINATION_FORBIDDEN');

    const scope=operation==='trash'?'storage:delete':'storage:move';
    // Require the same exact owner/connection/resource for source AND destination.
    const policy=this.connectors.registryPolicy();
    await policy.requireResource(ownerId,connectionId,scope,{kind:'mega-root',id:rootId,path:source});
    if (destination) await policy.requireResource(ownerId,connectionId,scope,
      {kind:'mega-root',id:rootId,path:destination});
    const target=await this.authorizedTarget(ownerId,connectionId,'mega',rootId,source);
    const next=destination ? await this.authorizedTarget(
      ownerId,connectionId,'mega',rootId,destination) : undefined;
    if (target.profile.provider!=='mega')throw new Error('TENANT_MEGA_PROVIDER_INVALID');

    // PG advisory lock serializes mutations for the same tenant+account across dynos.
    const client=await this.db().connect();
    let locked=false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]);locked=true;
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nyx-tenant-mega-write-'));
      const cfg=path.join(dir,'rclone.conf');
      try {
        await fs.chmod(dir,0o700);
        await fs.writeFile(cfg,tenantRcloneConfig(target.profile),{mode:0o600,flag:'wx'});
        const run=async(args:string[],maxOutput=256*1024):Promise<string> =>
          new Promise((resolve,reject)=>{
            let settled=false,bytes=0,stdout='';
            const child=spawn(this.binary,['--config',cfg,'--mega-hard-delete=false',
              '--retries=1',...args],{
                env:{PATH:process.env.PATH||'',HOME:dir,TMPDIR:dir,XDG_CONFIG_HOME:dir},
                stdio:['ignore','pipe','pipe'],
              });
            const finish=(error?:Error)=>{
              if(settled)return;settled=true;clearTimeout(timer);
              if(error)reject(error);else resolve(stdout);
            };
            const timer=setTimeout(()=>{
              child.kill('SIGKILL');finish(new Error('TENANT_MEGA_OPERATION_TIMEOUT'));
            },45000);
            child.stdout.on('data',(chunk:Buffer)=>{
              bytes+=chunk.length;
              if(bytes>maxOutput){child.kill('SIGKILL');
                finish(new Error('TENANT_MEGA_RESPONSE_OVERSIZE'));}
              else stdout+=chunk.toString('utf8');
            });
            // Provider stderr can contain sensitive account data.
            child.stderr.on('data',()=>{});
            child.once('error',()=>finish(new Error('TENANT_MEGA_COMMAND_FAILED')));
            child.once('close',code=>finish(code===0?undefined:
              new Error('TENANT_MEGA_COMMAND_FAILED')));
          });
        const findFile=async(fullPath:string)=>{
          const parent=path.posix.dirname(fullPath)==='.'?'':path.posix.dirname(fullPath);
          const leaf=path.posix.basename(fullPath);
          const raw=await run(['lsjson','tenant:'+parent,'--max-depth','1']);
          let listing:unknown;
          try{listing=JSON.parse(raw);}catch{throw new Error('TENANT_MEGA_LIST_INVALID');}
          if(!Array.isArray(listing) || listing.length>10000)
            throw new Error('TENANT_MEGA_LIST_INVALID');
          const matches=listing.filter(x=>x && typeof x==='object' &&
            (x as Record<string,unknown>).Path===leaf);
          if(matches.length>1)throw new Error('TENANT_MEGA_DUPLICATE_PATH');
          if(!matches.length)return null;
          const entry=matches[0] as Record<string,unknown>;
          if(entry.IsDir!==false)throw new Error('TENANT_MEGA_FILES_ONLY');
          return {id:typeof entry.ID==='string'?entry.ID:null,
            size:typeof entry.Size==='number'?entry.Size:null};
        };
        const before=await findFile(target.path);
        if(!before)throw new Error('TENANT_MEGA_SOURCE_MISSING');
        if(next && await findFile(next.path))
          throw new Error('TENANT_MEGA_DESTINATION_EXISTS');
        const receiptId=randomUUID();
        await client.query(`INSERT INTO nyx_rclone_mega_mutations_v1
          (id,owner_id,connection_id,root_id,operation,source_path,destination_path,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,'running')`,
          [receiptId,ownerId,connectionId,rootId,operation,source,destination||null]);
        try {
          if(operation==='trash') {
            // MEGA backend defaults to rubbish-bin deletion; hard-delete forced false.
            await run(['deletefile','tenant:'+target.path]);
          } else {
            // --ignore-existing additionally prevents overwrites if destination appears.
            await run(['moveto','tenant:'+target.path,'tenant:'+next!.path,'--ignore-existing']);
          }
          const missing=await findFile(target.path);
          const present=next?await findFile(next.path):null;
          if(missing || (next && (!present || present.size!==before.size)))
            throw new Error('TENANT_MEGA_POSTCHECK_UNCERTAIN');
          await client.query(`UPDATE nyx_rclone_mega_mutations_v1
            SET state='verified',completed_at=now() WHERE id=$1
            AND owner_id=$2 AND connection_id=$3`,[receiptId,ownerId,connectionId]);
          return {id:receiptId,operation,status:'verified' as const,
            sourcePath:source,destinationPath:destination||null,
            trashPolicy:operation==='trash'?'mega-provider-rubbish-bin':null,
            confirmationRequired:false};
        } catch {
          await client.query(`UPDATE nyx_rclone_mega_mutations_v1
            SET state='uncertain',completed_at=now() WHERE id=$1
            AND owner_id=$2 AND connection_id=$3`,[receiptId,ownerId,connectionId]);
          throw new Error('TENANT_MEGA_OPERATION_UNCERTAIN_CHECK_AUDIT');
        }
      } finally {
        await fs.rm(dir,{recursive:true,force:true});
      }
    } finally {
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]).catch(()=>{});
      client.release();
    }
  }


  /**
   * For an authenticated owner's one verified cloud namespace, select the
   * strongest connection eligible for the exact operation and root.
   * The starting ID must itself belong to the caller; namespace is fetched
   * from trusted server-side attestation, never from MCP/model arguments.
   */
  async selectBestAuthorizedConnection(ownerId:string,connectionId:string,
    rootId:string,operation:'storage:list'|'storage:write'|'storage:move'|'storage:delete',
    relativePath?:string) {
    const anchor=await this.owned(ownerId,connectionId);
    if(anchor.status!=='active')throw new Error('TENANT_SELECTION_ANCHOR_INACTIVE');
    if(!rootId)throw new Error('TENANT_SELECTION_ROOT_INVALID');
    const proof=await this.db().query(
      'SELECT provider,namespace FROM nyx_storage_verified_identity_v1 '+
      'WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,connectionId]);
    if(proof.rowCount!==1)throw new Error('TENANT_SELECTION_IDENTITY_UNVERIFIED');
    const provider=proof.rows[0].provider as TenantRcloneProvider;
    const namespace=proof.rows[0].namespace as string;
    if(provider!==anchor.provider||!namespace)
      throw new Error('TENANT_SELECTION_IDENTITY_INVALID');
    const linked=await this.db().query(
      'SELECT connection_id,owner_id,provider,namespace '+
      'FROM nyx_storage_verified_identity_v1 '+
      'WHERE owner_id=$1 AND provider=$2 AND namespace=$3',
      [ownerId,provider,namespace]);
    const records=await this.connectors.registryPolicy().list(ownerId);
    const connections=new Map(records.map(x=>[x.id,x]));
    const candidates=linked.rows.flatMap(row=>{
      const c=connections.get(row.connection_id as string);
      return c?[{connection:c,verifiedOwnerId:row.owner_id as string,
        verifiedProvider:row.provider as TenantRcloneProvider,
        verifiedNamespace:row.namespace as string}]:[];
    });
    const chosen=selectVerifiedStorageConnection(candidates,{
      ownerId,provider,verifiedNamespace:namespace,rootId,
      operation,path:relativePath,
    });
    return {connectionId:chosen.id,displayName:chosen.displayName,
      provider:chosen.provider,rootId,operation,
      selectionPolicy:'most-capable-eligible-within-verified-owner-and-namespace',
      readOnlyDecision:true};
  }

  /**
   * Attest an imported Google profile's REAL granted access via Google's
   * tokeninfo and Drive account permissionId. Never trust the local Rclone
   * scope declaration alone. Does not enable user-selected permissions.
   */
  async verifyExistingGoogleWriteGrant(ownerId:string,connectionId:string,rootId:string) {
    if(process.env.NYX_DEPLOYMENT_MODE!=='public' ||
       process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED!=='true')
      throw new Error('TENANT_GOOGLE_WRITE_VERIFICATION_DISABLED');
    const owned=await this.owned(ownerId,connectionId,'google-drive');
    if(owned.status!=='active')throw new Error('TENANT_GOOGLE_CONNECTION_INACTIVE');
    const selected=(owned.resources||[]).find(r=>
      r.kind==='drive'&&r.id===rootId&&r.capabilities.includes('storage:list'));
    if(!selected)throw new Error('TENANT_GOOGLE_ROOT_FORBIDDEN');
    // Verifies live connectivity and persists a refreshed OAuth token first.
    const probe=await this.probeAuthorizedRoot(ownerId,connectionId,'google-drive',rootId);
    if(probe!=='verified')throw new Error('TENANT_GOOGLE_PROVIDER_READ_FAILED');
    const active=await this.profile(ownerId,connectionId,'active');
    if(active.profile.provider!=='google-drive' ||
       active.profile.rootFolderId!==rootId ||
       active.profile.scope!=='drive')
      throw new Error('TENANT_GOOGLE_FULL_SCOPE_REQUIRED');
    let token:unknown;
    try{token=JSON.parse(active.profile.token);}catch{
      throw new Error('TENANT_GOOGLE_TOKEN_INVALID');
    }
    const access=(token as {access_token?:unknown})?.access_token;
    if(typeof access!=='string'||access.length<3||access.length>8192)
      throw new Error('TENANT_GOOGLE_TOKEN_INVALID');
    const query=new URL('https://oauth2.googleapis.com/tokeninfo');
    query.searchParams.set('access_token',access);
    const infoResponse=await fetch(query,{
      redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if(!infoResponse.ok)throw new Error('TENANT_GOOGLE_SCOPE_UNVERIFIED');
    const infoText=await infoResponse.text();
    if(infoText.length>16384)throw new Error('TENANT_GOOGLE_SCOPE_UNVERIFIED');
    let info:unknown;
    try{info=JSON.parse(infoText);}catch{throw new Error('TENANT_GOOGLE_SCOPE_UNVERIFIED');}
    const scope=(info as {scope?:unknown})?.scope;
    if(typeof scope!=='string' ||
       !scope.split(/\s+/).includes('https://www.googleapis.com/auth/drive'))
      throw new Error('TENANT_GOOGLE_FULL_SCOPE_REQUIRED');

    const whoResponse=await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)',{
      headers:{authorization:'Bearer '+access},
      redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if(!whoResponse.ok)throw new Error('TENANT_GOOGLE_IDENTITY_UNVERIFIED');
    const whoText=await whoResponse.text();
    if(whoText.length>16384)throw new Error('TENANT_GOOGLE_IDENTITY_UNVERIFIED');
    let who:unknown;
    try{who=JSON.parse(whoText);}catch{throw new Error('TENANT_GOOGLE_IDENTITY_UNVERIFIED');}
    const permissionId=(who as {user?:{permissionId?:unknown}})?.user?.permissionId;
    if(typeof permissionId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(permissionId))
      throw new Error('TENANT_GOOGLE_IDENTITY_UNVERIFIED');
    const sql=await this.db().query(
      "UPDATE nyx_connector_connections SET provider_capabilities=$4::jsonb,updated_at=now() "+
      "WHERE owner_id=$1 AND id=$2 AND status='active' AND provider='google-drive' "+
      "AND EXISTS (SELECT 1 FROM nyx_storage_verified_identity_v1 p "+
      "WHERE p.owner_id=$1 AND p.connection_id=$2 AND p.provider='google-drive' "+
      "AND p.external_id=$3) RETURNING id",
      [ownerId,connectionId,permissionId,
        JSON.stringify(['storage:list','storage:write','storage:move','storage:delete'])]);
    if(sql.rowCount!==1)throw new Error('TENANT_GOOGLE_ATTESTED_IDENTITY_MISMATCH');
    return {status:'provider_scope_verified' as const,connectionId,
      rootId,providerCapabilities:['storage:list','storage:write','storage:move','storage:delete'],
      selectedPermissionsUnchanged:true};
  }

  /** Create one bounded UTF-8 text file; never overwrites an existing object.
   * Binary/large uploads require a separate first-party upload implementation.
   */
  async createTenantTextFile(ownerId:string,connectionId:string,
    provider:TenantRcloneProvider,rootId:string,relativePath:string,content:string) {
    const enabled=provider==='google-drive'
      ? process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED==='true'
      : provider==='mega'&&process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true';
    if(process.env.NYX_DEPLOYMENT_MODE!=='public'||!enabled)
      throw new Error('TENANT_STORAGE_WRITES_DISABLED');
    if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>65536)
      throw new Error('TENANT_STORAGE_TEXT_SIZE_INVALID');
    const safePath=tenantRclonePath(relativePath);
    if(!relativePath||safePath!==relativePath||
       relativePath.split('/').some(p=>!p||p==='.'||p==='..'))
      throw new Error('TENANT_STORAGE_FILE_PATH_INVALID');
    const kind=provider==='mega'?'mega-root':'drive';
    await this.connectors.registryPolicy().requireResource(ownerId,connectionId,
      'storage:write',{kind,id:rootId,path:safePath});
    const target=await this.authorizedTarget(ownerId,connectionId,provider,rootId,safePath);
    if(target.profile.provider==='google-drive'&&target.profile.scope!=='drive')
      throw new Error('TENANT_GOOGLE_FULL_SCOPE_REQUIRED');
    const client=await this.db().connect();
    let locked=false;
    try{
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]);locked=true;
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nyx-tenant-create-'));
      const cfg=path.join(dir,'rclone.conf'),input=path.join(dir,'input.txt');
      try{
        await fs.chmod(dir,0o700);
        await fs.writeFile(cfg,tenantRcloneConfig(target.profile),{mode:0o600,flag:'wx'});
        await fs.writeFile(input,content,{mode:0o600,flag:'wx'});
        const run=(args:string[]):Promise<string>=>new Promise((resolve,reject)=>{
          let settled=false,bytes=0,output='';
          const child=spawn(this.binary,['--config',cfg,
            ...(provider==='mega'?['--mega-hard-delete=false']:['--drive-use-trash=true']),
            '--retries=1',...args],{
              env:{PATH:process.env.PATH||'',HOME:dir,TMPDIR:dir,XDG_CONFIG_HOME:dir},
              stdio:['ignore','pipe','pipe']});
          const finish=(error?:Error)=>{
            if(settled)return;settled=true;clearTimeout(timer);
            if(error)reject(error);else resolve(output);
          };
          const timer=setTimeout(()=>{
            child.kill('SIGKILL');finish(new Error('TENANT_STORAGE_CREATE_TIMEOUT'));
          },45000);
          child.stdout.on('data',(chunk:Buffer)=>{
            bytes+=chunk.length;
            if(bytes>256*1024){child.kill('SIGKILL');
              finish(new Error('TENANT_STORAGE_CREATE_OUTPUT_OVERSIZE'));}
            else output+=chunk.toString('utf8');
          });
          child.stderr.on('data',()=>{});
          child.once('error',()=>finish(new Error('TENANT_STORAGE_CREATE_FAILED')));
          child.once('close',code=>finish(code===0?undefined:
            new Error('TENANT_STORAGE_CREATE_FAILED')));
        });
        const find=async()=>{
          const parent=path.posix.dirname(target.path)==='.'?'':path.posix.dirname(target.path);
          const leaf=path.posix.basename(target.path);
          const raw=await run(['lsjson','tenant:'+parent,'--max-depth','1']);
          let entries:unknown;
          try{entries=JSON.parse(raw);}catch{throw new Error('TENANT_STORAGE_CREATE_LIST_INVALID');}
          if(!Array.isArray(entries)||entries.length>10000)
            throw new Error('TENANT_STORAGE_CREATE_LIST_INVALID');
          const found=entries.filter(x=>x&&typeof x==='object'&&
            (x as Record<string,unknown>).Path===leaf);
          if(found.length>1)throw new Error('TENANT_STORAGE_CREATE_DUPLICATE');
          return found.length?found[0] as Record<string,unknown>:null;
        };
        if(await find())throw new Error('TENANT_STORAGE_CREATE_EXISTS');
        const receiptId=randomUUID();
        await client.query(
          'INSERT INTO nyx_rclone_tenant_creations_v1 '+
          '(id,owner_id,connection_id,root_id,provider,target_path,state) '+
          "VALUES($1,$2,$3,$4,$5,$6,'running')",
          [receiptId,ownerId,connectionId,rootId,provider,safePath]);
        try{
          await run(['copyto',input,'tenant:'+target.path,'--immutable']);
          const created=await find();
          if(!created||created.IsDir!==false||
             created.Size!==Buffer.byteLength(content,'utf8'))
            throw new Error('TENANT_STORAGE_CREATE_POSTCHECK_UNCERTAIN');
          if(target.profile.provider==='google-drive')
            await this.persistActiveGoogleRefresh(ownerId,connectionId,
              target.profile,target.packed,cfg);
          await client.query(
            "UPDATE nyx_rclone_tenant_creations_v1 SET state='verified',completed_at=now() "+
            'WHERE id=$1 AND owner_id=$2 AND connection_id=$3',
            [receiptId,ownerId,connectionId]);
          return {id:receiptId,status:'verified' as const,
            provider,rootId,path:safePath,bytes:Buffer.byteLength(content,'utf8')};
        }catch{
          await client.query(
            "UPDATE nyx_rclone_tenant_creations_v1 SET state='uncertain',completed_at=now() "+
            'WHERE id=$1 AND owner_id=$2 AND connection_id=$3',
            [receiptId,ownerId,connectionId]);
          throw new Error('TENANT_STORAGE_CREATE_UNCERTAIN_CHECK_AUDIT');
        }
      }finally{await fs.rm(dir,{recursive:true,force:true});}
    }finally{
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]).catch(()=>{});
      client.release();
    }
  }

  /**
   * Scoped Google Drive file operations. Trash uses Drive's recoverable trash,
   * never Rclone --drive-use-trash=false, purge, or permanent deletion.
   * Provider consent, selected capabilities AND both root grants must agree.
   */
  async mutateGoogleFile(ownerId:string,connectionId:string,rootId:string,
    operation:'rename'|'move'|'trash',sourcePath:string,destinationPath?:string) {
    if(process.env.NYX_DEPLOYMENT_MODE!=='public' ||
       process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED!=='true')
      throw new Error('TENANT_GOOGLE_MUTATIONS_DISABLED');
    if(!['rename','move','trash'].includes(operation))
      throw new Error('TENANT_GOOGLE_OPERATION_INVALID');
    const clean=(value:string)=>{
      const normalized=tenantRclonePath(value);
      if(!value || normalized!==value ||
        value.split('/').some(part=>!part||part==='.'||part==='..'))
        throw new Error('TENANT_GOOGLE_FILE_PATH_INVALID');
      return normalized;
    };
    const source=clean(sourcePath);
    const dest=operation==='trash'?undefined:clean(destinationPath||'');
    if(operation==='trash'&&destinationPath!==undefined)
      throw new Error('TENANT_GOOGLE_TRASH_DESTINATION_FORBIDDEN');
    if(dest===source)throw new Error('TENANT_GOOGLE_NOOP_FORBIDDEN');
    if(operation==='rename'&&dest &&
      path.posix.dirname(source)!==path.posix.dirname(dest))
      throw new Error('TENANT_GOOGLE_RENAME_PARENT_CHANGED');

    const capability=operation==='trash'?'storage:delete':'storage:move';
    const policy=this.connectors.registryPolicy();
    await policy.requireResource(ownerId,connectionId,capability,
      {kind:'drive',id:rootId,path:source});
    if(dest)await policy.requireResource(ownerId,connectionId,capability,
      {kind:'drive',id:rootId,path:dest});
    const target=await this.authorizedTarget(ownerId,connectionId,'google-drive',rootId,source);
    const next=dest?await this.authorizedTarget(
      ownerId,connectionId,'google-drive',rootId,dest):undefined;
    if(target.profile.provider!=='google-drive' || target.profile.scope!=='drive')
      throw new Error('TENANT_GOOGLE_FULL_SCOPE_REQUIRED');

    const client=await this.db().connect();
    let locked=false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]);locked=true;
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nyx-tenant-google-write-'));
      const cfg=path.join(dir,'rclone.conf');
      try {
        await fs.chmod(dir,0o700);
        await fs.writeFile(cfg,tenantRcloneConfig(target.profile),{mode:0o600,flag:'wx'});
        const run=async(args:string[]):Promise<string>=>new Promise((resolve,reject)=>{
          let settled=false,bytes=0,stdout='';
          const child=spawn(this.binary,['--config',cfg,'--drive-use-trash=true',
            '--retries=1',...args],{
            env:{PATH:process.env.PATH||'',HOME:dir,TMPDIR:dir,XDG_CONFIG_HOME:dir},
            stdio:['ignore','pipe','pipe'],
          });
          const finish=(error?:Error)=>{
            if(settled)return;settled=true;clearTimeout(timer);
            if(error)reject(error);else resolve(stdout);
          };
          const timer=setTimeout(()=>{
            child.kill('SIGKILL');finish(new Error('TENANT_GOOGLE_OPERATION_TIMEOUT'));
          },45000);
          child.stdout.on('data',(chunk:Buffer)=>{
            bytes+=chunk.length;
            if(bytes>256*1024){
              child.kill('SIGKILL');finish(new Error('TENANT_GOOGLE_RESPONSE_OVERSIZE'));
            } else stdout+=chunk.toString('utf8');
          });
          // Never expose provider stderr (which may contain account data).
          child.stderr.on('data',()=>{});
          child.once('error',()=>finish(new Error('TENANT_GOOGLE_COMMAND_FAILED')));
          child.once('close',code=>finish(code===0?undefined:
            new Error('TENANT_GOOGLE_COMMAND_FAILED')));
        });
        const findFile=async(fullPath:string)=>{
          const parent=path.posix.dirname(fullPath)==='.'?'':path.posix.dirname(fullPath);
          const leaf=path.posix.basename(fullPath);
          const raw=await run(['lsjson','tenant:'+parent,'--max-depth','1']);
          let files:unknown;
          try{files=JSON.parse(raw);}catch{throw new Error('TENANT_GOOGLE_LIST_INVALID');}
          if(!Array.isArray(files)||files.length>10000)
            throw new Error('TENANT_GOOGLE_LIST_INVALID');
          const found=files.filter(x=>x&&typeof x==='object'&&
            (x as Record<string,unknown>).Path===leaf);
          if(found.length>1)throw new Error('TENANT_GOOGLE_DUPLICATE_PATH');
          if(!found.length)return null;
          const entry=found[0] as Record<string,unknown>;
          if(entry.IsDir!==false)throw new Error('TENANT_GOOGLE_FILES_ONLY');
          return {id:typeof entry.ID==='string'?entry.ID:null,
            size:typeof entry.Size==='number'?entry.Size:null};
        };
        const before=await findFile(target.path);
        if(!before)throw new Error('TENANT_GOOGLE_SOURCE_MISSING');
        if(next && await findFile(next.path))
          throw new Error('TENANT_GOOGLE_DESTINATION_EXISTS');
        const receiptId=randomUUID();
        await client.query(
          'INSERT INTO nyx_rclone_google_mutations_v1 '+
          '(id,owner_id,connection_id,root_id,operation,source_path,destination_path,state) '+
          "VALUES($1,$2,$3,$4,$5,$6,$7,'running')",
          [receiptId,ownerId,connectionId,rootId,operation,source,dest||null]);
        try {
          if(operation==='trash') {
            await run(['deletefile','tenant:'+target.path]);
          } else {
            await run(['moveto','tenant:'+target.path,'tenant:'+next!.path,'--ignore-existing']);
          }
          const missing=await findFile(target.path);
          const present=next?await findFile(next.path):null;
          if(missing||(next&&(!present||present.size!==before.size||
            (before.id&&present.id&&before.id!==present.id))))
            throw new Error('TENANT_GOOGLE_POSTCHECK_UNCERTAIN');
          await this.persistActiveGoogleRefresh(
            ownerId,connectionId,target.profile,target.packed,cfg);
          await client.query(
            "UPDATE nyx_rclone_google_mutations_v1 SET state='verified',completed_at=now() "+
            'WHERE id=$1 AND owner_id=$2 AND connection_id=$3',
            [receiptId,ownerId,connectionId]);
          return {id:receiptId,operation,status:'verified' as const,
            sourcePath:source,destinationPath:dest||null,
            trashPolicy:operation==='trash'?'google-drive-trash':null};
        } catch {
          await client.query(
            "UPDATE nyx_rclone_google_mutations_v1 SET state='uncertain',completed_at=now() "+
            'WHERE id=$1 AND owner_id=$2 AND connection_id=$3',
            [receiptId,ownerId,connectionId]);
          throw new Error('TENANT_GOOGLE_OPERATION_UNCERTAIN_CHECK_AUDIT');
        }
      } finally {
        await fs.rm(dir,{recursive:true,force:true});
      }
    } finally {
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',
        [ownerId,connectionId]).catch(()=>{});
      client.release();
    }
  }

  private async listIsolated(profile:TenantRcloneProfile, relativePath:string,
    afterSuccess?: (configPath:string)=>Promise<boolean>) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nyx-tenant-rclone-'));
    const config=path.join(directory,'rclone.conf');
    try {
      await fs.chmod(directory,0o700);
      await fs.writeFile(config,tenantRcloneConfig(profile),{mode:0o600,flag:'wx'});
      const target='tenant:'+tenantRclonePath(relativePath);
      const raw=await new Promise<string>((resolve,reject)=>{
        let done=false,stdout='',outputBytes=0;
        const child=spawn(this.binary,[
          '--config',config,'lsjson',target,'--max-depth','1',
        ],{
          env:{PATH:process.env.PATH||'',HOME:directory,TMPDIR:directory,
            XDG_CONFIG_HOME:directory},
          stdio:['ignore','pipe','pipe'],
        });
        const finish=(error?:Error)=>{
          if(done)return;
          done=true;clearTimeout(timer);
          if(error)reject(error);else resolve(stdout);
        };
        const timer=setTimeout(()=>{
          child.kill('SIGKILL');finish(new Error('TENANT_RCLONE_LIST_TIMEOUT'));
        },25000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',(chunk:string)=>{
          if(done)return;
          outputBytes+=Buffer.byteLength(chunk);
          if(outputBytes>512*1024){
            child.kill('SIGKILL');finish(new Error('TENANT_RCLONE_LIST_TOO_LARGE'));
            return;
          }
          stdout+=chunk;
        });
        child.stderr.on('data',()=>{}); // Never return remote error text or credentials.
        child.once('error',()=>finish(new Error('TENANT_RCLONE_LIST_FAILED')));
        child.once('close',code=>finish(code===0?undefined:new Error('TENANT_RCLONE_LIST_FAILED')));
      });
      let decoded:unknown;
      try{decoded=JSON.parse(raw);}catch{throw new Error('TENANT_RCLONE_LIST_INVALID');}
      if(!Array.isArray(decoded) || decoded.length>10000)
        throw new Error('TENANT_RCLONE_LIST_INVALID');
      const items=decoded.map(value=>{
        if(!value || typeof value!=='object')throw new Error('TENANT_RCLONE_LIST_INVALID');
        const item=value as Record<string,unknown>;
        if(typeof item.Path!=='string' || item.Path.length>1024 ||
           typeof item.IsDir!=='boolean')throw new Error('TENANT_RCLONE_LIST_INVALID');
        return {path:item.Path,isDir:item.IsDir,
          size:typeof item.Size==='number' && Number.isSafeInteger(item.Size)
            && item.Size>=0 ? item.Size:null};
      });
      if(afterSuccess && !(await afterSuccess(config)))
        throw new Error('TENANT_GOOGLE_REFRESH_NOT_SAVED');
      return {items:items.slice(0,100),truncated:items.length>100,readOnly:true};
    }finally{
      await fs.rm(directory,{recursive:true,force:true});
    }
  }

  /** Only one isolated config file per invocation; old shared config is never read or written. */
  private async probe(profile: TenantRcloneProfile, relativePath: string,
    captureSession?: (configPath: string) => Promise<boolean>): Promise<ReadProbeResult> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nyx-tenant-rclone-'));
    const config = path.join(directory, 'rclone.conf');
    try {
      await fs.chmod(directory, 0o700);
      await fs.writeFile(config, tenantRcloneConfig(profile), { mode: 0o600, flag: 'wx' });
      const target = 'tenant:' + tenantRclonePath(relativePath);
      const status=await new Promise<ReadProbeResult>((resolve) => {
        let settled = false;
        let seen = 0;
        const child = spawn(this.binary, [
          '--config', config, 'lsf', target, '--max-depth', '1', '--format', 'p',
        ], {
          // Never pass process-global rclone or legacy credential environment variables.
          env: { PATH: process.env.PATH || '', HOME: directory, TMPDIR: directory,
            XDG_CONFIG_HOME: directory },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (status: ReadProbeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(status);
        };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timeout'); }, 25000);
        const consume = (chunk: Buffer | string) => {
          seen += Buffer.byteLength(chunk);
          if (seen > 1024 * 1024) { child.kill('SIGKILL'); finish('failed'); }
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.once('error', () => finish('failed'));
        child.once('close', code => finish(code === 0 ? 'verified' : 'failed'));
      });
      if (status === 'verified' && captureSession) {
        try {return await captureSession(config) ? 'verified' : 'failed';}
        catch {return 'failed';}
      }
      return status;
    } finally {
      await fs.rm(directory, {recursive: true, force: true});
    }
  }
}
