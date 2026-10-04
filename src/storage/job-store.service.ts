import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CopyJobPayload, StorageJob } from './storage.types';

@Injectable()
export class JobStoreService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private readonly memory = new Map<string, StorageJob>();

  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS nyx_storage_jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        result jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query("UPDATE nyx_storage_jobs SET status = 'queued', updated_at = now() WHERE status = 'running'");
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  isDurable() {
    return Boolean(this.pool);
  }

  async createCopy(payload: CopyJobPayload): Promise<StorageJob> {
    const id = randomUUID();
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO nyx_storage_jobs (id, type, payload, status)
         VALUES ($1, 'copy-file', $2::jsonb, 'queued') RETURNING *`,
        [id, JSON.stringify(payload)],
      );
      return this.rowToJob(result.rows[0]);
    }
    const now = new Date().toISOString();
    const job: StorageJob = { id, type: 'copy-file', payload, status: 'queued', attempts: 0, createdAt: now, updatedAt: now };
    this.memory.set(id, job);
    return job;
  }

  async get(id: string): Promise<StorageJob | undefined> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM nyx_storage_jobs WHERE id = $1', [id]);
      return result.rowCount ? this.rowToJob(result.rows[0]) : undefined;
    }
    return this.memory.get(id);
  }

  async claimNext(): Promise<StorageJob | undefined> {
    if (this.pool) {
      const result = await this.pool.query(`
        WITH next_job AS (
          SELECT id FROM nyx_storage_jobs
          WHERE status = 'queued'
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE nyx_storage_jobs j
        SET status = 'running', attempts = attempts + 1, updated_at = now()
        FROM next_job
        WHERE j.id = next_job.id
        RETURNING j.*
      `);
      return result.rowCount ? this.rowToJob(result.rows[0]) : undefined;
    }

    for (const job of this.memory.values()) {
      if (job.status === 'queued') {
        job.status = 'running';
        job.attempts += 1;
        job.updatedAt = new Date().toISOString();
        return { ...job };
      }
    }
    return undefined;
  }

  async succeed(id: string, resultValue: unknown) {
    if (this.pool) {
      await this.pool.query(
        "UPDATE nyx_storage_jobs SET status = 'succeeded', result = $2::jsonb, error = NULL, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(resultValue)],
      );
      return;
    }
    const job = this.memory.get(id);
    if (job) {
      job.status = 'succeeded';
      job.result = resultValue;
      job.error = undefined;
      job.updatedAt = new Date().toISOString();
    }
  }

  async fail(id: string, error: string) {
    if (this.pool) {
      await this.pool.query(
        "UPDATE nyx_storage_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
        [id, error.slice(0, 12000)],
      );
      return;
    }
    const job = this.memory.get(id);
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.updatedAt = new Date().toISOString();
    }
  }

  private rowToJob(row: any): StorageJob {
    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
