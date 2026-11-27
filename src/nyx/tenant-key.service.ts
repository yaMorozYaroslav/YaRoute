import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { KeyEngine, KeyCandidate, KeyStore, KeyStage } from './key-engine';
import { parseKeyFsCommand, keyFsFingerprint, keyFsTransactionId } from './key-fs.command';

/**
 * Public Dev never reuses operator MAIN or global rclone. Each OAuth subject
 * receives a separate SQL namespace, derived server-side and not client-supplied.
 * A distinct Neon DATABASE_URL must be configured for this deployment.
 */
@Injectable()
export class NyxTenantKeyService {
  private pool?: Pool;
  private init?: Promise<void>;

  private async ready(): Promise<Pool> {
    const url = process.env.DATABASE_URL;
    if (!url) throw Error('KEY_TENANT_DATABASE_NOT_CONFIGURED');
    if (!this.pool) this.pool = new Pool({ connectionString:url, max:2 });
    if (!this.init) this.init = this.pool.query(
      `CREATE TABLE IF NOT EXISTS nyx_tenant_key_artifacts_v1 (
        tenant_id TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, artifact_path),
        CHECK (octet_length(content) <= 2097152)
      )`
    ).then(()=>undefined).catch(()=>{
      this.init = undefined;
      throw Error('KEY_TENANT_STORE_UNAVAILABLE');
    });
    await this.init;
    return this.pool;
  }

  async execute(
    owner: string,
    input: {
      stage: KeyStage;
      scope: 'local'|'global';
      transactionId: string;
      candidates: KeyCandidate[];
    },
  ) {
    // Public Dev is opt-in per explicit authenticated tool invocation. A
    // deliberate false config is the emergency rollback/kill switch.
    if (process.env.NYX_KEY_TENANT_ENABLED === 'false')
      throw Error('KEY_TENANT_STAGE_NOT_ENABLED');
    if (!/^oauth:[A-Za-z0-9._:@|\-]{1,300}$/.test(owner))
      throw Error('KEY_OWNER_NOT_VERIFIED');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.transactionId))
      throw Error('KEY_TRANSACTION_INVALID');
    const tenant = createHash('sha256').update('nyx-key-tenant-v1:' + owner).digest('hex');
    const db = await this.ready();
    const root = 'temp_key.json';
    // Idempotent tenant initialization; no other OAuth subject can read it.
    await db.query(
      `INSERT INTO nyx_tenant_key_artifacts_v1 (tenant_id, artifact_path, content)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, artifact_path) DO NOTHING`,
      [tenant,root,JSON.stringify({candidates:[]})],
    );
    const store: KeyStore = {
      read: async name => {
        const r = await db.query(
          'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2',
          [tenant,name],
        );
        return r.rows[0]?.content ?? null;
      },
      writeNew: async (name,content) => {
        if (Buffer.byteLength(content,'utf8') > 2097152) throw Error('KEY_ARTIFACT_TOO_LARGE');
        const r = await db.query(
          `INSERT INTO nyx_tenant_key_artifacts_v1 (tenant_id,artifact_path,content)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING artifact_path`,
          [tenant,name,content],
        );
        if (r.rowCount !== 1) throw Error('KEY_TRANSACTION_CONFLICT');
      },
      compareAndSwap: async (name,previous,next) => {
        if (Buffer.byteLength(next,'utf8') > 2097152) throw Error('KEY_ARTIFACT_TOO_LARGE');
        const r = await db.query(
          `UPDATE nyx_tenant_key_artifacts_v1 SET content=$1, updated_at=now()
           WHERE tenant_id=$2 AND artifact_path=$3 AND content=$4
           RETURNING artifact_path`, [next,tenant,name,previous],
        );
        return r.rowCount === 1;
      },
    };
    const result=await new KeyEngine(store).execute({
      stage:input.stage,scope:input.scope,
      keyPath:root,seedDirectory:'transactions',
      candidates:input.candidates,transactionId:input.transactionId,
    });
    return {...result,tenantIsolated:true,provider:'neon-postgres',
      rawTranscriptStored:false,canonicalChanged:false};
  }
  /**
   * One authenticated user invocation, two KEY stages, ONE Neon transaction:
   * F verified -> S verified -> immutable chain completion -> COMMIT/readback.
   * Retries with identical evidence return the stored result without mutation.
   */
  async executeFs(owner:string, input:{
    command:string;
    candidates:KeyCandidate[];
    transactionId?:string;
  }) {
    const parsed=parseKeyFsCommand(input.command);
    if (process.env.NYX_KEY_TENANT_ENABLED === 'false')
      throw Error('KEY_TENANT_STAGE_NOT_ENABLED');
    if (!/^oauth:[A-Za-z0-9._:@|\\-]{1,300}$/.test(owner))
      throw Error('KEY_OWNER_NOT_VERIFIED');
    const fingerprint=keyFsFingerprint(parsed.scope,input.candidates);
    const transactionId=keyFsTransactionId(fingerprint,input.transactionId);
    const tenant=createHash('sha256').update('nyx-key-tenant-v1:'+owner).digest('hex');
    const db=await this.ready();
    const root='temp_key.json', seedDirectory='transactions';
    const receiptF=seedDirectory+'/key_'+transactionId+'_F.receipt.json';
    const receiptS=seedDirectory+'/key_'+transactionId+'_S.receipt.json';
    const donePath=seedDirectory+'/key_'+transactionId+'.fs.done.json';
    const client=await db.connect();
    let started=false;
    try {
      await client.query('BEGIN');
      started=true;
      await client.query(
        `INSERT INTO nyx_tenant_key_artifacts_v1 (tenant_id, artifact_path, content)
         VALUES ($1,$2,$3) ON CONFLICT (tenant_id, artifact_path) DO NOTHING`,
        [tenant,root,JSON.stringify({candidates:[]})],
      );
      // Serialize all KEY changes for this tenant. No mixed-source partial seeds.
      const locked=await client.query(
        'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2 FOR UPDATE',
        [tenant,root],
      );
      if (locked.rowCount!==1) throw Error('KEY_TENANT_ACTIVE_MISSING');
      const store:KeyStore={
        read:async name=>{
          const r=await client.query(
            'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2',
            [tenant,name],
          );
          return r.rows[0]?.content??null;
        },
        writeNew:async(name,content)=>{
          if (Buffer.byteLength(content,'utf8')>2097152)
            throw Error('KEY_ARTIFACT_TOO_LARGE');
          const r=await client.query(
            `INSERT INTO nyx_tenant_key_artifacts_v1(tenant_id,artifact_path,content)
             VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING artifact_path`,
            [tenant,name,content],
          );
          if(r.rowCount!==1)throw Error('KEY_TRANSACTION_CONFLICT');
        },
        compareAndSwap:async(name,previous,next)=>{
          if(Buffer.byteLength(next,'utf8')>2097152)
            throw Error('KEY_ARTIFACT_TOO_LARGE');
          const r=await client.query(
            `UPDATE nyx_tenant_key_artifacts_v1 SET content=$1,updated_at=now()
             WHERE tenant_id=$2 AND artifact_path=$3 AND content=$4
             RETURNING artifact_path`,
            [next,tenant,name,previous],
          );
          return r.rowCount===1;
        },
      };
      const existing=await store.read(donePath);
      if(existing!==null){
        let receipt:any;
        try{receipt=JSON.parse(existing);}catch{throw Error('KEY_FS_REPLAY_RECEIPT_INVALID');}
        if(receipt.schema!=='nyx.key.fs.done.v1' ||
          receipt.fingerprint!==fingerprint ||
          receipt.scope!==parsed.scope ||
          receipt.transactionId!==transactionId)
          throw Error('KEY_FS_REPLAY_CONFLICT');
        const f=await store.read(receiptF),s=await store.read(receiptS);
        if(!f||!s)throw Error('KEY_FS_REPLAY_RECEIPT_MISSING');
        let fr:any,sr:any;
        try{fr=JSON.parse(f);sr=JSON.parse(s);}catch{throw Error('KEY_FS_REPLAY_RECEIPT_INVALID');}
        if(fr.stage!=='oF'||sr.stage!=='oS'||
          fr.afterSha256!==sr.beforeSha256||
          sr.afterSha256!==receipt.afterSha256)
          throw Error('KEY_FS_REPLAY_RECEIPT_INVALID');
        await client.query('COMMIT');started=false;
        return {
          schema:'nyx.key.fs-result.v1' as const,status:'APPLIED' as const,
          command:parsed.expanded,scope:parsed.scope,transactionId,
          receiptPath:donePath,seedStatus:'pending_validation' as const,
          replayed:true,tenantIsolated:true,canonicalChanged:false,
          stages:['oF','oS'] as const,
        };
      }
      const engine=new KeyEngine(store);
      const first=await engine.execute({
        stage:'oF',scope:parsed.scope,keyPath:root,seedDirectory,
        candidates:input.candidates,transactionId:transactionId+'_F',
      });
      if(first.status!=='APPLIED'||!first.activeUpdated)
        throw Error('KEY_FS_FILE_NOT_APPLIED');
      const second=await engine.execute({
        stage:'oS',scope:parsed.scope,keyPath:root,seedDirectory,
        candidates:input.candidates,transactionId:transactionId+'_S',
      });
      if(second.status!=='APPLIED'||!second.activeUpdated)
        throw Error('KEY_FS_SEED_NOT_APPLIED');
      if(!second.mutations.some(m=>m.path.endsWith('.seed.json')))
        throw Error('KEY_FS_SEED_PROPOSAL_EMPTY');
      const frText=await store.read(receiptF),srText=await store.read(receiptS);
      if(!frText||!srText)throw Error('KEY_FS_STAGE_RECEIPT_MISSING');
      const fr=JSON.parse(frText),sr=JSON.parse(srText);
      if(fr.stage!=='oF'||sr.stage!=='oS'||fr.afterSha256!==sr.beforeSha256)
        throw Error('KEY_FS_STAGE_CHAIN_INVALID');
      const done=JSON.stringify({
        schema:'nyx.key.fs.done.v1',status:'APPLIED',transactionId,
        fingerprint,scope:parsed.scope,
        firstReceipt:receiptF,secondReceipt:receiptS,
        beforeSha256:fr.beforeSha256,afterSha256:sr.afterSha256,
        seedStatus:'pending_validation',canonicalChanged:false,
      },null,2)+'\n';
      await store.writeNew(donePath,done);
      if(await store.read(donePath)!==done)throw Error('KEY_FS_DONE_READBACK_FAILED');
      await client.query('COMMIT');started=false;
      // Independent post-commit readback; committed bytes, not a staged plan.
      const committed=await db.query(
        'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2',
        [tenant,donePath],
      );
      if(committed.rows[0]?.content!==done)
        throw Error('KEY_FS_COMMIT_READBACK_FAILED');
      return {
        schema:'nyx.key.fs-result.v1' as const,status:'APPLIED' as const,
        command:parsed.expanded,scope:parsed.scope,transactionId,
        receiptPath:donePath,seedStatus:'pending_validation' as const,
        replayed:false,tenantIsolated:true,canonicalChanged:false,
        stages:['oF','oS'] as const,
        stageReceipts:{oF:receiptF,oS:receiptS},
        mutationCounts:{oF:first.mutations.length,oS:second.mutations.length},
      };
    }catch(e){
      if(started)try{await client.query('ROLLBACK');}catch{/* no success asserted */}
      throw e;
    }finally{
      client.release();
    }
  }

  /** Verified, read-only view of the ACTIVE KEY for exactly this OAuth tenant.
   * Includes historical archived candidates, because FIN may not silently
   * discard any valid unconsumed key just because triage archived it.
   */
  async inspectPlanningSource(owner:string) {
    if(!/^oauth:[A-Za-z0-9._:@|\\-]{1,300}$/.test(owner))
      throw Error('KEY_OWNER_NOT_VERIFIED');
    const tenant=createHash('sha256').update('nyx-key-tenant-v1:'+owner).digest('hex');
    const db=await this.ready();
    const rows=await db.query(
      'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2',
      [tenant,'temp_key.json'],
    );
    if(rows.rowCount!==1||typeof rows.rows[0]?.content!=='string')
      throw Error('KEY_TENANT_ACTIVE_MISSING');
    const bytes=rows.rows[0].content as string;
    let value:any;
    try{value=JSON.parse(bytes)}catch{throw Error('KEY_TENANT_ACTIVE_INVALID');}
    if(!value||!Array.isArray(value.candidates)||
       (value.archived!==undefined&&!Array.isArray(value.archived)))
      throw Error('KEY_TENANT_ACTIVE_INVALID');
    const candidates=[...value.candidates,...(value.archived||[])];
    if(candidates.length>2000)throw Error('KEY_TENANT_ACTIVE_TOO_LARGE');
    const check=await db.query(
      'SELECT content FROM nyx_tenant_key_artifacts_v1 WHERE tenant_id=$1 AND artifact_path=$2',
      [tenant,'temp_key.json'],
    );
    if(check.rows[0]?.content!==bytes)
      throw Error('KEY_TENANT_ACTIVE_READBACK_CONFLICT');
    return {
      provider:'neon-postgres' as const,
      scope:'owner-isolated' as const,
      path:'temp_key.json' as const,
      sha256:createHash('sha256').update(bytes).digest('hex'),
      activeCount:value.candidates.length,
      archivedCount:(value.archived||[]).length,
      candidates:candidates as KeyCandidate[],
      readbackVerified:true,
      canonicalChanged:false,
    };
  }

}
