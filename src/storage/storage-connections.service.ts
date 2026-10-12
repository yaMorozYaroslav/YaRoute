import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PUBLIC_STORAGE_SCHEMA, PublicStorageSlot } from './public-storage-schema';

export type StoredConnection = {
  owner: string;
  slot: PublicStorageSlot;
  provider: 'drive' | 'mega';
  credential: Record<string, unknown>;
};

/** Encrypted, owner-scoped storage registry. Never return credential to HTTP/MCP clients. */
@Injectable()
export class StorageConnectionsService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private key?: Buffer;

  async onModuleInit() {
    if (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') return;
    // Legacy fixed-slot public storage remains disabled in connector-only mode.
    const encoded = process.env.NYX_STORAGE_ENCRYPTION_KEY || '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('NYX_STORAGE_ENCRYPTION_KEY must be canonical base64');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('NYX_STORAGE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for public storage');
    this.key = key;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_user_connections (
      owner text NOT NULL,
      slot text NOT NULL,
      provider text NOT NULL,
      encrypted_credential text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner, slot)
    )`);
  }

  async onModuleDestroy() { await this.pool?.end(); }

  private db(): Pool {
    if (!this.pool || !this.key) throw new Error('PUBLIC_STORAGE_CONNECTIONS_UNAVAILABLE');
    return this.pool;
  }

  private assertSlot(slot: string): PublicStorageSlot {
    if (!Object.prototype.hasOwnProperty.call(PUBLIC_STORAGE_SCHEMA, slot)) {
      throw new Error('UNSUPPORTED_STORAGE_SLOT');
    }
    return slot as PublicStorageSlot;
  }

  private assertOwner(owner: string) {
    if (!owner || !owner.startsWith('oauth:') || owner.length > 512) {
      throw new Error('AUTHENTICATED_OWNER_REQUIRED');
    }
  }

  async list(owner: string) {
    this.assertOwner(owner);
    const rows = await this.db().query(
      'SELECT slot, provider, updated_at FROM nyx_user_connections WHERE owner = $1 ORDER BY slot',
      [owner],
    );
    return rows.rows.map((row) => ({
      slot: row.slot,
      provider: row.provider,
      access: PUBLIC_STORAGE_SCHEMA[this.assertSlot(row.slot)].access,
      updatedAt: row.updated_at,
    }));
  }

  async get(owner: string, slot: string): Promise<StoredConnection | undefined> {
    this.assertOwner(owner);
    const validSlot = this.assertSlot(slot);
    const result = await this.db().query(
      'SELECT provider, encrypted_credential FROM nyx_user_connections WHERE owner = $1 AND slot = $2',
      [owner, validSlot],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    if (row.provider !== PUBLIC_STORAGE_SCHEMA[validSlot].provider) {
      throw new Error('STORAGE_PROVIDER_MISMATCH');
    }
    const packed = Buffer.from(row.encrypted_credential, 'base64');
    if (packed.length < 29) throw new Error('INVALID_ENCRYPTED_CREDENTIAL');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key!, iv);
    decipher.setAAD(Buffer.from(JSON.stringify([owner, validSlot, row.provider])));
    decipher.setAuthTag(tag);
    const credential = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    return { owner, slot: validSlot, provider: row.provider, credential };
  }

  async put(owner: string, slot: string, credential: Record<string, unknown>) {
    this.assertOwner(owner);
    const validSlot = this.assertSlot(slot);
    const provider = PUBLIC_STORAGE_SCHEMA[validSlot].provider;
    if (!credential || Array.isArray(credential) || typeof credential !== 'object') {
      throw new Error('INVALID_STORAGE_CREDENTIAL');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, validSlot, provider])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    await this.db().query(
      `INSERT INTO nyx_user_connections(owner, slot, provider, encrypted_credential)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(owner, slot) DO UPDATE SET
       provider = EXCLUDED.provider, encrypted_credential = EXCLUDED.encrypted_credential,
       updated_at = now()`,
      [owner, validSlot, provider, packed],
    );
  }

  async remove(owner: string, slot: string) {
    this.assertOwner(owner);
    await this.db().query('DELETE FROM nyx_user_connections WHERE owner = $1 AND slot = $2', [owner, this.assertSlot(slot)]);
  }

  assertWritable(slot: string) {
    if (PUBLIC_STORAGE_SCHEMA[this.assertSlot(slot)].access !== 'write') {
      throw new Error('STORAGE_SLOT_READ_ONLY');
    }
  }
}
