import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

export type ScopedRcloneProvider = 'google-drive' | 'mega';
const remotePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate a single bounded remote profile before sealing it in Neon. */
export function assertSingleRcloneProfile(provider:ScopedRcloneProvider, remote:string, config:string) {
  if (!['google-drive','mega'].includes(provider) || !remotePattern.test(remote) ||
      typeof config !== 'string' || Buffer.byteLength(config,'utf8')>32768 ||
      config.includes('\0')) throw new Error('RCLONE_PROFILE_INVALID');
  const headers=[...config.matchAll(/^\s*\[([^\]\r\n]+)\]\s*$/gm)].map(m=>m[1]);
  if (headers.length!==1 || headers[0]!==remote) throw new Error('RCLONE_PROFILE_INVALID');
  const types=[...config.matchAll(/^\s*type\s*=\s*(\S+)\s*$/gm)].map(m=>m[1]);
  if (types.length!==1 || types[0] !== (provider==='google-drive'?'drive':'mega')) {
    throw new Error('RCLONE_PROFILE_INVALID');
  }
  // Do not support indirect local credential sources or interpolation.
  if (/^\s*(?:service_account_file|token_file|env_auth|config_file|shell_command)\s*=/mi.test(config) ||
      /\$\{|%[^%\r\n]+%/.test(config)) throw new Error('RCLONE_PROFILE_UNSAFE');
  for (const line of config.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[;#]/.test(line) || /^\s*\[[^\]]+\]\s*$/.test(line)) continue;
    if (!/^\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*.*$/.test(line)) throw new Error('RCLONE_PROFILE_INVALID');
  }
}

@Injectable()
export class RcloneCredentialVaultService implements OnModuleInit, OnModuleDestroy {
  private pool?:Pool;
  private key?:Buffer;
  isEnabled() { return process.env.NYX_RCLONE_VAULT_ENABLED === 'true'; }
  async onModuleInit() {
    if (!this.isEnabled()) return;
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') throw new Error('PUBLIC_RCLONE_RUNTIME_DISABLED');
    const raw=process.env.NYX_RCLONE_CREDENTIAL_KEY||'';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || !process.env.DATABASE_URL) {
      throw new Error('RCLONE_VAULT_CONFIGURATION_REQUIRED');
    }
    const key=Buffer.from(raw,'base64');
    if (key.length!==32) throw new Error('RCLONE_VAULT_CONFIGURATION_INVALID');
    this.key=key;
    this.pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:5000});
    await this.pool.query([
      'CREATE TABLE IF NOT EXISTS nyx_rclone_credential_vault (',
      'owner_id text NOT NULL, connection_id uuid NOT NULL,',
      "provider text NOT NULL CHECK (provider IN ('google-drive','mega')),",
      'remote_name text NOT NULL, ciphertext text NOT NULL,',
      'updated_at timestamptz NOT NULL DEFAULT now(),',
      'PRIMARY KEY(owner_id,connection_id))',
    ].join(' '));
  }
  async onModuleDestroy(){await this.pool?.end();this.key?.fill(0);}
  private db():Pool{
    if(!this.isEnabled()||!this.pool||!this.key)throw new Error('RCLONE_VAULT_NOT_CONFIGURED');
    return this.pool;
  }
  private aad(owner:string,id:string,provider:ScopedRcloneProvider,remote:string):Buffer{
    if(typeof owner!=='string'||!/^oauth:[^\x00-\x1f]{1,500}$/.test(owner)||
      !uuidPattern.test(id)||!remotePattern.test(remote)||
      !['google-drive','mega'].includes(provider))throw new Error('RCLONE_VAULT_IDENTITY_INVALID');
    return Buffer.from(JSON.stringify([owner,id,provider,remote]));
  }
  /** Internal operator-only method: no MCP/HTTP credential-input API. */
  async store(owner:string,id:string,provider:ScopedRcloneProvider,remote:string,profile:string){
    const db=this.db();
    const aad=this.aad(owner,id,provider,remote);
    assertSingleRcloneProfile(provider,remote,profile);
    const iv=randomBytes(12);
    const enc=createCipheriv('aes-256-gcm',this.key!,iv);enc.setAAD(aad);
    // Finalize before reading the GCM tag.
    const ct=Buffer.concat([enc.update(profile,'utf8'),enc.final()]);
    const sealed=Buffer.concat([iv,enc.getAuthTag(),ct]).toString('base64');
    const sql=[
      'INSERT INTO nyx_rclone_credential_vault(owner_id,connection_id,provider,remote_name,ciphertext)',
      'SELECT $1,$2,$3,$4,$5 FROM nyx_connector_connections c',
      "WHERE c.owner_id=$1 AND c.id=$2::text AND c.provider=$3 AND c.external_account_id=$4 AND c.status <> 'revoked'",
      'ON CONFLICT(owner_id,connection_id) DO UPDATE SET provider=EXCLUDED.provider,',
      'remote_name=EXCLUDED.remote_name,ciphertext=EXCLUDED.ciphertext,updated_at=now()',
      'RETURNING connection_id',
    ].join(' ');
    const r=await db.query(sql,[owner,id,provider,remote,sealed]);
    if(r.rowCount!==1)throw new Error('RCLONE_VAULT_CONNECTION_NOT_OWNED');
    return {connectionId:id,stored:true};
  }
  async load(owner:string,id:string,provider:ScopedRcloneProvider,remote:string):Promise<string|undefined>{
    const db=this.db(),aad=this.aad(owner,id,provider,remote);
    const sql=[
      'SELECT v.ciphertext FROM nyx_rclone_credential_vault v',
      'JOIN nyx_connector_connections c ON c.id=v.connection_id::text',
      'WHERE v.owner_id=$1 AND v.connection_id=$2 AND v.provider=$3 AND v.remote_name=$4',
      "AND c.owner_id=$1 AND c.provider=$3 AND c.external_account_id=$4 AND c.status <> 'revoked'",
    ].join(' ');
    const r=await db.query(sql,[owner,id,provider,remote]);
    if(!r.rowCount)return undefined;
    try{
      const packed=Buffer.from(r.rows[0].ciphertext,'base64');
      if(packed.length<29)throw new Error();
      const dec=createDecipheriv('aes-256-gcm',this.key!,packed.subarray(0,12));
      dec.setAuthTag(packed.subarray(12,28));dec.setAAD(aad);
      const plain=Buffer.concat([dec.update(packed.subarray(28)),dec.final()]);
      const result=plain.toString('utf8');
      assertSingleRcloneProfile(provider,remote,result);
      plain.fill(0);
      return result;
    }catch{throw new Error('RCLONE_VAULT_DECRYPT_FAILED');}
  }
  async revoke(owner:string,id:string){
    if(!this.isEnabled())return;
    if(!/^oauth:[^\x00-\x1f]{1,500}$/.test(owner)||!uuidPattern.test(id)){
      throw new Error('RCLONE_VAULT_IDENTITY_INVALID');
    }
    await this.db().query(
      'DELETE FROM nyx_rclone_credential_vault WHERE owner_id=$1 AND connection_id=$2',[owner,id]);
  }
}
