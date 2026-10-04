import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { InitScope, InitSession } from './init.types';

@Injectable()
export class InitSessionStoreService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private readonly memory = new Map<string, InitSession>();

  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS nyx_init_sessions (
        id uuid PRIMARY KEY,
        target text,
        scope text NOT NULL,
        receipt jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  isDurable() {
    return Boolean(this.pool);
  }

  async upsert(
    existingId: string | undefined,
    target: string | undefined,
    scope: InitScope,
    receipt: unknown,
  ): Promise<InitSession> {
    if (existingId) {
      return this.update(existingId, target, scope, receipt);
    }

    const id = randomUUID();
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO nyx_init_sessions (id, target, scope, receipt)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *`,
        [id, target ?? null, scope, JSON.stringify(receipt)],
      );
      return this.rowToSession(result.rows[0]);
    }

    const now = new Date().toISOString();
    const session: InitSession = {
      id,
      target,
      scope,
      receipt,
      createdAt: now,
      updatedAt: now,
    };
    this.memory.set(id, session);
    return session;
  }

  async get(id: string): Promise<InitSession | undefined> {
    if (this.pool) {
      const result = await this.pool.query(
        'SELECT * FROM nyx_init_sessions WHERE id = $1',
        [id],
      );
      return result.rowCount ? this.rowToSession(result.rows[0]) : undefined;
    }
    return this.memory.get(id);
  }

  private async update(
    id: string,
    target: string | undefined,
    scope: InitScope,
    receipt: unknown,
  ): Promise<InitSession> {
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE nyx_init_sessions
         SET target = $2, scope = $3, receipt = $4::jsonb, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, target ?? null, scope, JSON.stringify(receipt)],
      );
      if (!result.rowCount) throw new Error('Initialization session not found');
      return this.rowToSession(result.rows[0]);
    }

    const existing = this.memory.get(id);
    if (!existing) throw new Error('Initialization session not found');
    const updated: InitSession = {
      ...existing,
      target,
      scope,
      receipt,
      updatedAt: new Date().toISOString(),
    };
    this.memory.set(id, updated);
    return updated;
  }

  private rowToSession(row: any): InitSession {
    return {
      id: row.id,
      target: row.target ?? undefined,
      scope: row.scope as InitScope,
      receipt: row.receipt,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
