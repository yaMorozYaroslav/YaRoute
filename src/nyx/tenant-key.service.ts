import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { KeyEngine, KeyCandidate, KeyStore, KeyStage } from './key-engine';

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
}
