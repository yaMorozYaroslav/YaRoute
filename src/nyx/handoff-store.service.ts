import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ResourceRef } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';

export type ChatScope = 'local' | 'global';
export type ChatDepth = 'basic' | 'normal' | 'deep';
export type ChatAccess = {
  backend_areas: string[] | string;
  external_context: string[];
};
export type ChatConfigState = {
  modifier: string;
  scope: ChatScope;
  depth: ChatDepth;
  access: ChatAccess;
  source: 'default' | 'explicit' | 'request' | 'operation';
};
export type ChatConfigChange = {
  operation: '++' | '--';
  from: string;
  to: string;
  at: string;
};
export type ChatConfig = {
  initial: ChatConfigState;
  current: ChatConfigState;
  history: ChatConfigChange[];
};

export type Fif = {
  schema: 'nyx.fif.v1'; id: string; created_at: string;
  command: { name: string; targets: string[]; depth: string };
  canonical: { head: string; body: string; footer: string };
  cli: { version: string; sha256: string; profile_sha256?: string };
  loaded_context: { areas: string[]; sources: string[] };
  source_refs: Array<{ key: string; ref: ResourceRef; sha256: string; bytes: number; returned: boolean }>;
  chat_config?: ChatConfig;
  continuity: { predecessor?: ResourceRef }; message_count: number | 'UNKNOWN';
};
type Checkpoint = { id: string; kind: 'FIF' | 'FIB'; ref: ResourceRef; sha256: string; fingerprint: string; promotionHash?: string; fif: Fif };
export interface FifPromotionPort {
  promote(owner: string, conversationId: string, handoffs: ResourceRef, summary: { markdown: string; data: unknown }): Promise<Checkpoint>;
}
export function artifactId(owner: string, conversation: string) { return sha256(JSON.stringify([owner, conversation])); }
export function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:postgres(?:ql)?|mysql):\/\/|\bBearer\s+[A-Za-z0-9._~-]{24,}/i.test(text)) throw new Error('SECRET_CONTENT_REJECTED');
  if (/(?:["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key|api[_-]?key|rclone[_-]?config|database[_-]?url)["']?\s*[:=]\s*)(?!null\b|["']{2})(?:[^\s,}]+)/i.test(text)) throw new Error('SECRET_FIELD_REJECTED');
}
@Injectable()
export class HandoffStore implements OnModuleInit, OnModuleDestroy, FifPromotionPort {
  private pool?: Pool;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly resources: NyxResourceStore) {}
  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_handoff_lineage (id text PRIMARY KEY, checkpoint jsonb NOT NULL)`);
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private async locked<T>(id: string, action: (old: Checkpoint | undefined, save: (next: Checkpoint) => Promise<void>) => Promise<T>, handoffs?: ResourceRef) {
    if (!this.pool) {
      if (process.env.NYX_HANDOFF_COORDINATION !== 'single-dyno' || process.env.DYNO !== 'web.1' || !handoffs) throw new Error('DURABLE_HANDOFF_LOCK_NOT_CONFIGURED');
      return this.remoteLocked(id, handoffs, action);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const result = await client.query('SELECT checkpoint FROM nyx_handoff_lineage WHERE id=$1', [id]);
      const value = await action(result.rows[0]?.checkpoint, async next => {
        await client.query('INSERT INTO nyx_handoff_lineage(id, checkpoint) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint', [id, JSON.stringify(next)]);
      });
      await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async initialize(owner: string, conversationId: string | undefined, handoffs: ResourceRef, metadata: Omit<Fif, 'schema' | 'id' | 'created_at' | 'continuity' | 'message_count'>) {
    const conversation = conversationId ?? randomUUID();
    const id = artifactId(owner, conversation);
    const fingerprint = sha256(JSON.stringify(metadata));
    assertNoSecrets(metadata);
    const checkpoint = await this.locked(id, async (old, save) => {
      if (old) await this.verify(old);
      if (old?.fingerprint === fingerprint) return old;
      const fif: Fif = { schema: 'nyx.fif.v1', id, created_at: new Date().toISOString(), ...metadata, continuity: old ? { predecessor: old.ref } : {}, message_count: 'UNKNOWN' };
      const revision = sha256(JSON.stringify([fingerprint, old?.sha256]));
      const filename = old ? `FIF_${id}.revisions/${revision}.json` : `FIF_${id}.json`;
      const ref = { ...handoffs, path: `${handoffs.path}/${filename}` };
      const existing = await this.resources.optionalRead(ref);
      if (existing !== undefined) {
        const parsed = JSON.parse(existing);
        if (typeof parsed.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at))) throw new Error('ARTIFACT_RECOVERY_INVALID');
        fif.created_at = parsed.created_at;
        if (existing !== JSON.stringify(fif, null, 2) + '\n') throw new Error('ARTIFACT_RECOVERY_CONFLICT');
      }
      const text = JSON.stringify(fif, null, 2) + '\n';
      const receipt = await this.resources.createVerified(ref, text, { existing });
      const next: Checkpoint = { id, kind: old?.kind ?? 'FIF', ref, sha256: receipt.sha256, fingerprint, fif };
      await save(next); return next;
    }, handoffs);
    return { ...checkpoint, conversationId: conversation, verified: true };
  }

  async reconfigure(owner: string, conversationId: string, handoffs: ResourceRef, operation: 'upgrade' | 'downgrade') {
    const id = artifactId(owner, conversationId);
    const checkpoint = await this.locked(id, async (old, save) => {
      if (!old) throw new Error('FIF_NOT_INITIALIZED');
      await this.verify(old);
      const config = old.fif.chat_config;
      if (!config) throw new Error('FIF_SCOPE_CONFIG_MISSING');
      const desired: ChatScope = operation === 'upgrade' ? 'global' : 'local';
      const before = config.current;
      const op = operation === 'upgrade' ? '++' as const : '--' as const;
      if (before.scope === desired) return { checkpoint: old, changed: false, from: before.modifier, to: before.modifier };
      const scopeCode = desired === 'local' ? 'L' : 'G';
      const depthCode = before.depth === 'basic' ? 'B' : before.depth === 'normal' ? 'N' : 'D';
      const to = `o${scopeCode}${depthCode}`;
      const now = new Date().toISOString();
      const nextConfig: ChatConfig = {
        initial: config.initial,
        current: { ...before, scope: desired, modifier: to, source: 'operation', access: this.accessFor(config, desired) },
        history: [...config.history, { operation: op, from: before.modifier, to, at: now }],
      };
      const fif: Fif = { ...old.fif, chat_config: nextConfig, continuity: { predecessor: old.ref } };
      assertNoSecrets(fif);
      const fingerprint = sha256(JSON.stringify({ previous: old.fingerprint, chat_config: nextConfig }));
      const revision = sha256(JSON.stringify([fingerprint, old.sha256]));
      const ref = { ...handoffs, path: `${handoffs.path}/FIF_${id}.revisions/${revision}.json` };
      const text = JSON.stringify(fif, null, 2) + '\n';
      const existing = await this.resources.optionalRead(ref);
      if (existing !== undefined && existing !== text) throw new Error('ARTIFACT_RECOVERY_CONFLICT');
      const receipt = await this.resources.createVerified(ref, text, { existing });
      const next: Checkpoint = { ...old, ref, sha256: receipt.sha256, fingerprint, fif };
      await save(next);
      return { checkpoint: next, changed: true, from: before.modifier, to };
    }, handoffs);
    return { ...checkpoint.checkpoint, conversationId, verified: true, changed: checkpoint.changed, from: checkpoint.from, to: checkpoint.to };
  }

  private accessFor(config: ChatConfig, scope: ChatScope): ChatAccess {
    if (scope === config.initial.scope) return config.initial.access;
    if (scope === 'local') {
      const local = config.initial.scope === 'local' ? config.initial.access.backend_areas : ['MAIN'];
      return { backend_areas: Array.isArray(local) ? local : ['MAIN'], external_context: config.current.access.external_context };
    }
    return { backend_areas: 'all_configured_nyx_drives', external_context: config.current.access.external_context };
  }

  async promote(owner: string, conversationId: string, handoffs: ResourceRef, summary: { markdown: string; data: unknown }) {
    assertNoSecrets(summary);
    const id = artifactId(owner, conversationId);
    return this.locked(id, async (old, save) => {
      if (!old) throw new Error('FIF_NOT_INITIALIZED');
      await this.verify(old);
      const promotionHash = sha256(JSON.stringify([old.fif, summary]));
      if (old.kind === 'FIB' && old.promotionHash === promotionHash) return old;
      const hash = sha256(JSON.stringify([promotionHash, old.sha256]));
      const root = `${handoffs.path}/FIB_${id}`;
      const source = old.fif;
      const outputs: Record<string, string> = {
        'fif.json': JSON.stringify(source, null, 2) + '\n',
        'summary.md': summary.markdown,
        'summary.json': JSON.stringify(summary.data, null, 2) + '\n',
        'sources.json': JSON.stringify(source.source_refs, null, 2) + '\n',
        'continuity.json': JSON.stringify({ id, predecessor: old.ref }, null, 2) + '\n',
      };
      const refs = [];
      for (const [file, content] of Object.entries(outputs)) {
        const ref = { ...handoffs, path: `${root}/revisions/${hash}/${file}` };
        refs.push({ ref, ...(await this.resources.createVerified(ref, content)) });
      }
      const ref = { ...handoffs, path: `${root}/revisions/${hash}/manifest.json` };
      const text = JSON.stringify({ schema: 'nyx.fib.v1', id, revision: hash, files: refs }, null, 2) + '\n';
      const receipt = await this.resources.createVerified(ref, text);
      const next: Checkpoint = { ...old, kind: 'FIB', ref, sha256: receipt.sha256, promotionHash };
      await save(next); return next;
    }, handoffs);
  }
  private async remoteLocked<T>(id: string, handoffs: ResourceRef, action: (old: Checkpoint | undefined, save: (next: Checkpoint) => Promise<void>) => Promise<T>): Promise<T> {
    const prior = this.pending.get(id) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(async () => {
      let root = { ...handoffs, path: `${handoffs.path}/runtime_lineage` };
      let entries = await this.resources.optionalList(root);
      let prefix = `${id}.`;
      if (entries.some(x => x.IsDir && x.Name === id)) {
        root = { ...root, path: `${root.path}/${id}` };
        entries = await this.resources.optionalList(root);
        prefix = '';
      }
      const files = entries.filter(x => !x.IsDir && x.Name.startsWith(prefix) && /^\d{10}\.json$/.test(x.Name.slice(prefix.length))).sort((a, b) => a.Name.localeCompare(b.Name));
      const names = new Set(files.map(x => x.Name));
      if (names.size !== files.length) throw new Error('DUPLICATE_LINEAGE_CHECKPOINT');
      const last = files.at(-1);
      let old: Checkpoint | undefined;
      if (last) {
        const record = JSON.parse(await this.resources.read({ ...root, path: `${root.path}/${last.Name}` }));
        if (record.schema !== 'nyx.handoff-ledger.v1' || record.checkpoint.id !== id) throw new Error('LINEAGE_CHECKPOINT_INVALID');
        old = record.checkpoint;
        assertNoSecrets(old);
      }
      return action(old, async next => {
        const sequence = last ? Number(last.Name.slice(prefix.length, prefix.length + 10)) + 1 : 1;
        if (sequence > 9999999999) throw new Error('LINEAGE_SEQUENCE_EXHAUSTED');
        const ref = { ...root, path: `${root.path}/${prefix}${String(sequence).padStart(10, '0')}.json` };
        const text = JSON.stringify({ schema: 'nyx.handoff-ledger.v1', checkpoint: next }, null, 2) + '\n';
        await this.resources.createVerified(ref, text, { existing: undefined });
      });
    });
    this.pending.set(id, work);
    try { return await work; }
    finally { if (this.pending.get(id) === work) this.pending.delete(id); }
  }
  private async verify(checkpoint: Checkpoint) {
    const content = await this.resources.read(checkpoint.ref);
    if (sha256(content) !== checkpoint.sha256) throw new Error('HANDOFF_CHECKPOINT_CHANGED');
    const document = JSON.parse(content);
    if (document.schema === 'nyx.fib.v1') {
      for (const file of document.files) {
        if (sha256(await this.resources.read(file.ref)) !== file.sha256) throw new Error('FIB_MEMBER_CHANGED');
      }
    }
  }
}
