import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { ConnectorsService } from './connectors.service';

export type TenantRcloneProvider = 'google-drive' | 'mega';
export type TenantRcloneProfile =
  | { provider: 'google-drive'; token: string; clientId?: string;
      clientSecret?: string; rootFolderId?: string; scope?: 'drive.readonly' | 'drive.file' | 'drive' }
  | { provider: 'mega'; user: string; obscuredPassword: string;
      sessionId?: string; masterKey?: string;
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
  }

  async onModuleDestroy() { await this.pool?.end(); }

  private db(): Pool {
    if (!this.pool || !this.encryptionKey) throw new Error('TENANT_RCLONE_NOT_ENABLED');
    return this.pool;
  }

  private owner(ownerId: string, connectionId: string) {
    if (typeof ownerId !== 'string' || !/^oauth:[^\x00-\x1f]{1,500}$/.test(ownerId) ||
        typeof connectionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(connectionId)) {
      throw new Error('TENANT_RCLONE_IDENTITY_REQUIRED');
    }
  }

  private async owned(ownerId: string, connectionId: string, provider?: TenantRcloneProvider) {
    this.owner(ownerId, connectionId);
    const item = await this.connectors.getOwned(ownerId, connectionId).catch(() => undefined);
    if (!item || item.status === 'revoked' ||
        !['google-drive', 'mega'].includes(item.provider) ||
        (provider && provider !== item.provider)) {
      throw new Error('TENANT_RCLONE_CONNECTION_FORBIDDEN');
    }
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
      const packed = refreshedProfile
        ? this.seal(ownerId, connectionId, durableProfile) : candidate.packed;
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
        FOR UPDATE`, [ownerId, connectionId, grant.provider]);
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
