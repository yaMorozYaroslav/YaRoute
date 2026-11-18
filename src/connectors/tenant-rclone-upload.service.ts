import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectorsService } from './connectors.service';
import { TenantRcloneService, type TenantRcloneProvider } from './tenant-rclone.service';
import { assertPublicTenantGoogleOwnerId } from './public-tenant-provider.policy';
import { parseSelectedLocalRclone, parseLocalRcloneBatch } from './tenant-rclone-file-import';

function publicOrigin() {
  const origin = process.env.NYX_PUBLIC_URL || '';
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(origin))
    throw new Error('RCLONE_IMPORT_PUBLIC_URL_INVALID');
  return origin.replace(/\/$/, '');
}
function digest(state: string) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(state))
    throw new Error('RCLONE_IMPORT_STATE_INVALID');
  return createHash('sha256').update(state).digest('hex');
}

/** First-party HTTPS owner-bound single-use upload. Raw bytes never cross MCP. */
@Injectable()
export class TenantRcloneUploadService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  constructor(private readonly connections:ConnectorsService,
              private readonly storage:TenantRcloneService) {}

  async onModuleInit() {
    if (process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED !== 'true') return;
    if (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' ||
        process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true' ||
        !process.env.DATABASE_URL)
      throw new Error('RCLONE_IMPORT_TENANT_ISOLATION_REQUIRED');
    this.pool = new Pool({connectionString:process.env.DATABASE_URL,max:2});
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_rclone_import_upload_states_v1 ('+
      'digest text PRIMARY KEY,owner_id text NOT NULL,connection_id text NOT NULL,'+
      "provider text NOT NULL CHECK (provider IN ('google-drive','mega')),"+
      'root_id text NOT NULL,expires_at timestamptz NOT NULL)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS nyx_rclone_import_batch_states_v1 ('+
      'digest text PRIMARY KEY, owner_id text NOT NULL,'+
      'connection_ids jsonb NOT NULL,expires_at timestamptz NOT NULL)');
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private db() {
    if (!this.pool) throw new Error('RCLONE_IMPORT_NOT_ENABLED');
    return this.pool;
  }
  private async pending(ownerId:string,connectionId:string) {
    assertPublicTenantGoogleOwnerId(ownerId);
    const connection=await this.connections.getOwned(ownerId,connectionId);
    if (connection.status!=='pending' ||
        !['google-drive','mega'].includes(connection.provider))
      throw new Error('RCLONE_IMPORT_PENDING_CONNECTION_REQUIRED');
    const provider=connection.provider as TenantRcloneProvider;
    const resources=(connection.resources||[]).filter(r=>
      r.kind===(provider==='mega'?'mega-root':'drive') &&
      r.capabilities.includes('storage:list'));
    if(resources.length!==1||typeof resources[0].id!=='string'||
       resources[0].id.length>256)
      throw new Error('RCLONE_IMPORT_SELECTED_ROOT_REQUIRED');
    if(provider==='mega' && resources[0].id!=='MEGA_ROOT')
      throw new Error('RCLONE_IMPORT_MEGA_ROOT_UNSUPPORTED');
    return {provider,rootId:resources[0].id};
  }

  async begin(ownerId:string,connectionId:string) {
    const origin=publicOrigin();
    const {provider,rootId}=await this.pending(ownerId,connectionId);
    const state=randomBytes(32).toString('base64url');
    await this.db().query(
      'DELETE FROM nyx_rclone_import_upload_states_v1 WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,connectionId]);
    await this.db().query(
      'INSERT INTO nyx_rclone_import_upload_states_v1 '+
      '(digest,owner_id,connection_id,provider,root_id,expires_at) '+
      "VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
      [digest(state),ownerId,connectionId,provider,rootId]);
    return {url:origin+'/connect/rclone/import?state='+encodeURIComponent(state),
      expiresInSeconds:600,
      message:'Open the first-party HTTPS page and select your local Rclone file. No credentials in ChatGPT.'};
  }

  /** One button per authenticated user, not one link per remote. */
  async beginAll(ownerId:string) {
    assertPublicTenantGoogleOwnerId(ownerId);
    const origin=publicOrigin();
    const state=randomBytes(32).toString('base64url');
    await this.db().query(
      'INSERT INTO nyx_rclone_import_batch_states_v1 '+
      "(digest,owner_id,connection_ids,expires_at) VALUES($1,$2,'[]'::jsonb,"+
      "now()+interval '10 minutes')",
      [digest(state),ownerId]);
    return {url:origin+'/connect/rclone/import/batch?state='+encodeURIComponent(state),
      expiresInSeconds:600,
      message:'Upload a local Rclone file once; supported remotes are processed individually under this authenticated owner.'};
  }

  async canDisplayAll(state:string) {
    const row=await this.db().query(
      'SELECT digest FROM nyx_rclone_import_batch_states_v1 '+
      'WHERE digest=$1 AND connection_ids=$2::jsonb AND expires_at>now()',
      [digest(state),'[]']);
    return row.rowCount===1;
  }

  /** Stages all supported remotes. The browser performs individual read probes afterwards
   * so Heroku's per-request timeout cannot interrupt an eight-remote batch.
   */
  async stageAll(state:string,config:string) {
    const row=await this.db().query(
      'DELETE FROM nyx_rclone_import_batch_states_v1 '+
      'WHERE digest=$1 AND connection_ids=$2::jsonb AND expires_at>now() '+
      'RETURNING owner_id',[digest(state),'[]']);
    if(row.rowCount!==1)throw new Error('RCLONE_BATCH_LINK_EXPIRED');
    const ownerId=row.rows[0].owner_id as string;
    assertPublicTenantGoogleOwnerId(ownerId);
    const parsed=parseLocalRcloneBatch(config);
    const preexisting=await this.connections.listStorage(ownerId);
    const existing=new Map(preexisting.filter(x=>x.status!=='revoked')
      .map(x=>[x.displayName.toLowerCase(),x]));
    const staged:{id:string;name:string;provider:TenantRcloneProvider}[]=[];
    const skipped:string[]=[];
    const failed:string[]=[];
    for(const remote of parsed.items){
      try{
        let item=existing.get(remote.name.toLowerCase());
        if(item) {
          // Resume only an identical unverified pending placeholder; never
          // overwrite an active or already credentialed connection.
          const res=item.resources||[];
          const expectedKind=remote.provider==='mega'?'mega-root':'drive';
          const matching=item.status==='pending'&&
            item.externalAccountId==='pending'&&item.provider===remote.provider&&
            item.capabilities.length===1&&item.capabilities[0]==='storage:list'&&
            item.providerCapabilities.length===0&&res.length===1&&
            res[0].kind===expectedKind&&res[0].id===remote.rootId&&
            res[0].capabilities.length===1&&res[0].capabilities[0]==='storage:list';
          if(!matching){skipped.push(remote.name);continue;}
        }else{
          item=await this.connections.createStorage(ownerId,remote.provider,remote.name);
          existing.set(remote.name.toLowerCase(),item);
          await this.connections.storagePermissions(ownerId,item.id,['storage:list']);
          await this.connections.storageResources(ownerId,item.id,[{
            kind:remote.provider==='mega'?'mega-root':'drive',
            id:remote.rootId,capabilities:['storage:list'],
          }]);
        }
        const result=await this.storage.stageImportedCredentialIfAbsent(
          ownerId,item.id,remote.profile);
        if(result.staged)staged.push({id:item.id,name:remote.name,provider:remote.provider});
        else skipped.push(remote.name);
      }catch{
        // Do not include tokens, passwords, provider stderr or SQL details.
        failed.push(remote.name);
      }
    }
    const continuation=randomBytes(32).toString('base64url');
    await this.db().query(
      'INSERT INTO nyx_rclone_import_batch_states_v1 '+
      '(digest,owner_id,connection_ids,expires_at) '+
      "VALUES($1,$2,$3::jsonb,now()+interval '30 minutes')",
      [digest(continuation),ownerId,JSON.stringify(staged.map(x=>x.id))]);
    return {status:'pending_read_probes' as const, continuation,
      staged,alreadyPresent:skipped,unsupported:parsed.unsupported,
      rejected:parsed.rejected,failed};
  }

  /** Each request operates on ONE id authorized by the one-use batch upload. */
  async probeAndActivateAllStep(continuation:string,id:string) {
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))
      throw new Error('RCLONE_BATCH_ID_INVALID');
    const result=await this.db().query(
      'SELECT owner_id,connection_ids FROM nyx_rclone_import_batch_states_v1 '+
      'WHERE digest=$1 AND expires_at>now()',
      [digest(continuation)]);
    if(result.rowCount!==1)throw new Error('RCLONE_BATCH_SESSION_EXPIRED');
    const ownerId=result.rows[0].owner_id as string;
    assertPublicTenantGoogleOwnerId(ownerId);
    const ids=result.rows[0].connection_ids as unknown;
    if(!Array.isArray(ids)||!ids.includes(id))
      throw new Error('RCLONE_BATCH_CONNECTION_NOT_AUTHORIZED');
    const own=await this.connections.getOwned(ownerId,id);
    if(own.status==='active')return {id,status:'active' as const};
    if(own.status!=='pending')return {id,status:'failed' as const};
    const probe=await this.storage.probePending(ownerId,id);
    if(probe!=='verified')return {id,status:'read_failed' as const};
    const active=await this.storage.activateImportedReadOnly(ownerId,id);
    return {id,status:active.status,provider:active.provider};
  }

  async canDisplay(state:string) {
    const result=await this.db().query(
      'SELECT digest FROM nyx_rclone_import_upload_states_v1 '+
      'WHERE digest=$1 AND expires_at>now()', [digest(state)]);
    return result.rowCount===1;
  }

  async complete(state:string,remote:string,config:string) {
    const result=await this.db().query(
      'DELETE FROM nyx_rclone_import_upload_states_v1 '+
      'WHERE digest=$1 AND expires_at>now() '+
      'RETURNING owner_id,connection_id,provider,root_id',[digest(state)]);
    if(result.rowCount!==1)throw new Error('RCLONE_IMPORT_EXPIRED');
    const row=result.rows[0] as {owner_id:string;connection_id:string;
      provider:TenantRcloneProvider;root_id:string};
    const selected=await this.pending(row.owner_id,row.connection_id);
    if(selected.provider!==row.provider||selected.rootId!==row.root_id)
      throw new Error('RCLONE_IMPORT_CONNECTION_CHANGED');
    const profile=parseSelectedLocalRclone(config,remote,row.provider,row.root_id);
    await this.storage.stageCredential(row.owner_id,row.connection_id,profile);
    const status=await this.storage.probePending(row.owner_id,row.connection_id);
    if(status!=='verified')throw new Error('RCLONE_IMPORT_READ_NOT_VERIFIED');
    return {status:'pending_activation',readVerified:true,
      message:'Return to Connections and activate the verified pending connection.'};
  }
}
