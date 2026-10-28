import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ConnectorsService } from './connectors.service';
import { TenantRcloneService } from './tenant-rclone.service';

function publicBase() {
  const value = process.env.NYX_PUBLIC_URL || '';
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(value)) {
    throw new Error('TENANT_MEGA_PUBLIC_URL_INVALID');
  }
  return value.replace(/\/$/, '');
}

/**
 * Secure MEGA handoff: passwords are submitted only to a first-party HTTPS form,
 * never to ChatGPT/MCP. No password is placed in an argv, URL or log.
 * An optional user-entered 2FA code is consumed for initial Rclone login only.
 * A reusable session must be captured or the enrollment fails closed.
 */
@Injectable()
export class TenantMegaEnrollmentService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private readonly binary = process.env.RCLONE_BINARY || path.resolve('.bin/rclone');
  constructor(private readonly connections: ConnectorsService,
              private readonly storage: TenantRcloneService) {}

  async onModuleInit() {
    if (process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true') return;
    if (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' ||
        !process.env.DATABASE_URL) throw new Error('TENANT_MEGA_PUBLIC_ISOLATION_REQUIRED');
    this.pool = new Pool({connectionString:process.env.DATABASE_URL,max:3});
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_rclone_mega_enroll_states_v2 (' +
      'digest text PRIMARY KEY, owner_id text NOT NULL, connection_id text NOT NULL,' +
      'root_path text NOT NULL, expires_at timestamptz NOT NULL)');
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private db() {
    if (!this.pool) throw new Error('TENANT_MEGA_NOT_ENABLED');
    return this.pool;
  }
  private root(root: string) {
    if (typeof root !== 'string' || !root || root.length > 256 ||
        root.startsWith('/') || !/^[A-Za-z0-9_.\/-]+$/.test(root) ||
        root.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('TENANT_MEGA_ROOT_INVALID');
    }
    return root;
  }
  async begin(ownerId: string, connectionId: string, rootPath: string) {
    const origin = publicBase();
    const root = this.root(rootPath);
    const c = await this.connections.getOwned(ownerId,connectionId);
    if (c.provider !== 'mega' || c.status === 'revoked' ||
        !(c.resources || []).some(rule => rule.kind==='mega-root' &&
          rule.id===root && rule.capabilities.includes('storage:list'))) {
      throw new Error('TENANT_MEGA_ROOT_NOT_SELECTED');
    }
    const state = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(state).digest('hex');
    await this.db().query('DELETE FROM nyx_rclone_mega_enroll_states_v2 ' +
      'WHERE owner_id=$1 AND connection_id=$2', [ownerId,connectionId]);
    await this.db().query('INSERT INTO nyx_rclone_mega_enroll_states_v2 ' +
      '(digest,owner_id,connection_id,root_path,expires_at) ' +
      "VALUES ($1,$2,$3,$4,now()+interval '10 minutes')",
      [digest,ownerId,connectionId,root]);
    return {url:origin+'/connect/mega/setup?state='+encodeURIComponent(state),
      expiresInSeconds:600,message:'Enter MEGA credentials only in the NestNyx HTTPS page, never in a ChatGPT message.'};
  }

  async canDisplay(state: string) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(state)) return false;
    const digest = createHash('sha256').update(state).digest('hex');
    const result = await this.db().query('SELECT digest FROM nyx_rclone_mega_enroll_states_v2 ' +
      'WHERE digest=$1 AND expires_at>now()', [digest]);
    return result.rowCount === 1;
  }

  /** Obscuring is not encryption; encrypted database custody is still mandatory. */
  private async obscure(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024 ||
        /[\r\n\x00]/.test(password)) throw new Error('TENANT_MEGA_PASSWORD_INVALID');
    return new Promise((resolve,reject) => {
      let output = '';
      let done = false;
      const child = spawn(this.binary, ['obscure','-'], {
        env:{PATH:process.env.PATH || '', HOME:'/tmp'},
        stdio:['pipe','pipe','pipe'],
      });
      const finish = (error?:Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (!/^[A-Za-z0-9_\-+/=]{10,4096}$/.test(output.trim())) {
          reject(new Error('TENANT_MEGA_OBSCURE_FAILED'));
        } else resolve(output.trim());
      };
      const timer = setTimeout(()=>{
        child.kill('SIGKILL');finish(new Error('TENANT_MEGA_OBSCURE_TIMEOUT'));
      },8000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',(data:string)=>{
        output += data;
        if (output.length>4096) {child.kill('SIGKILL');finish(new Error('TENANT_MEGA_OBSCURE_FAILED'));}
      });
      child.stderr.on('data',()=>{}); // Never surface rclone stderr.
      child.on('error',()=>finish(new Error('TENANT_MEGA_OBSCURE_FAILED')));
      child.on('close',code=>finish(code===0?undefined:new Error('TENANT_MEGA_OBSCURE_FAILED')));
      child.stdin.on('error',()=>{});
      child.stdin.end(password+'\n');
    });
  }

  /** Consumes a one-time capability; verifies MEGA read access before granting it. */
  async complete(state: string, email: string, password: string, twoFactorCode?: string) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(state) ||
        typeof email !== 'string' || !/^[^\s@\x00-\x1f]{1,100}@[^\s@\x00-\x1f]{1,100}$/.test(email) ||
        typeof password !== 'string' || !password || password.length > 1024 ||
        /[\r\n\x00]/.test(password) ||
        (twoFactorCode !== undefined && twoFactorCode !== '' &&
         !/^[0-9]{6}$/.test(twoFactorCode))) {
      throw new Error('TENANT_MEGA_ENROLLMENT_INVALID');
    }
    const normalized = email.trim().toLowerCase();
    const digest = createHash('sha256').update(state).digest('hex');
    const row = await this.db().query('DELETE FROM nyx_rclone_mega_enroll_states_v2 ' +
      'WHERE digest=$1 AND expires_at>now() RETURNING owner_id,connection_id,root_path',
      [digest]);
    if (row.rowCount !== 1) throw new Error('TENANT_MEGA_ENROLLMENT_EXPIRED');
    const {owner_id:ownerId,connection_id:connectionId,root_path:root} = row.rows[0];
    const item = await this.connections.getOwned(ownerId,connectionId);
    if (item.provider!=='mega' || item.status==='revoked' ||
        (item.status==='active' && item.externalAccountId!==normalized) ||
        !(item.resources || []).some(r=>r.kind==='mega-root' && r.id===root &&
          r.capabilities.includes('storage:list'))) {
      throw new Error('TENANT_MEGA_CONNECTION_CHANGED');
    }
    const pass = await this.obscure(password);
    await this.storage.stageCredential(ownerId,connectionId,
      {provider:'mega',user:normalized,obscuredPassword:pass});
    // Prove the exact one-time, owner-selected MEGA root—not merely the account root.
    const check = twoFactorCode
      ? await this.storage.probePending(ownerId,connectionId,root,twoFactorCode)
      : await this.storage.probePending(ownerId,connectionId,root);
    if (check !== 'verified') throw new Error('TENANT_MEGA_READ_PROBE_FAILED');
    await this.connections.confirmStorageProvider(ownerId,connectionId,'mega',normalized);
    return {status:'pending_activation',provider:'mega'};
  }
}
