import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { assertPublicTenantGoogleOwnerId, assertPublicTenantStorageProvider } from './public-tenant-provider.policy';
import { ConnectorsService } from './connectors.service';

export type TenantRcloneProvider = 'google-drive' | 'mega';
export type TenantRcloneProfile =
  | { provider: 'google-drive'; token: string; clientId?: string;
      clientSecret?: string; rootFolderId?: string; scope?: 'drive.readonly' | 'drive.file' | 'drive' }
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
    if (profile.rootFolderId) lines.push('root_folder_id = ' + safeLine(profile.rootFolderId, 2048));
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
      } : undefined);
    if (status === 'verified' && oneTimeMegaCode && !refreshedProfile)
      return 'failed';
    if (status === 'verified') {
      // Replace a one-time 2FA code with reusable, encrypted session keys.
      // Never retain the OTP in a pending or active credential row.
      const durableProfile = refreshedProfile || candidate.profile;
      const verifiedProfile: TenantRcloneProfile = durableProfile.provider === 'mega'
        ? {...durableProfile, verifiedRoot: relativePath || 'MEGA_ROOT'} : durableProfile;
      const packed = verifiedProfile.provider === 'mega'
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
      return {profile:active.profile, path:clean};
    }
    const root = resourceId === 'MEGA_ROOT' ? '' : tenantRclonePath(resourceId);
    if (active.profile.provider !== 'mega' ||
        active.profile.verifiedRoot !== (root || 'MEGA_ROOT')) {
      throw new Error('TENANT_MEGA_VERIFIED_ROOT_CHANGED');
    }
    return {profile:active.profile, path:tenantRclonePath([root,clean].filter(Boolean).join('/'))};
  }

  /** Read-only status; neither returns names nor touches private/global remotes. */
  async probeAuthorizedRoot(ownerId: string, connectionId: string, provider: TenantRcloneProvider,
                            resourceId: string, relativePath = ''): Promise<ReadProbeResult> {
    const target = await this.authorizedTarget(ownerId,connectionId,provider,resourceId,relativePath);
    return this.probe(target.profile,target.path);
  }

  /**
   * First actual per-user storage read API: list at most 100 entries at depth one.
   * Rclone runs with a unique config containing one tenant's encrypted-vault profile.
   * No shared/local Rclone configuration, inherited provider credentials, or write operations.
   */
  async listAuthorizedRoot(ownerId:string, connectionId:string, provider:TenantRcloneProvider,
                           resourceId:string, relativePath='') {
    const target=await this.authorizedTarget(ownerId,connectionId,provider,resourceId,relativePath);
    return this.listIsolated(target.profile,target.path);
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

  private async listIsolated(profile:TenantRcloneProfile, relativePath:string) {
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
