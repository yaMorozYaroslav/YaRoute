import { createHash } from 'node:crypto';
import { parseLegacyKey, appendLegacyProposals } from './key-legacy';

/** Storage-independent KEY engine. Provider implementations own atomic writes and readback. */
export interface KeyStore {
  read(path: string): Promise<string | null>;
  writeNew(path: string, content: string): Promise<void>;
}
export interface KeyCandidate {
  id: string;
  target: 'head' | 'body' | 'footer';
  description: string;
  confidence: number;
  source: string;
  blocked?: boolean;
}
export type KeyStage = 'oF' | 'oS';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const safe = (s: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(s);
export class KeyEngine {
  constructor(private readonly store: KeyStore) {}
  async execute(input: { stage: KeyStage; scope: 'local' | 'global'; keyPath: string; seedDirectory: string; candidates: KeyCandidate[]; transactionId: string }) {
    if (!safe(input.transactionId) || !input.keyPath || !input.seedDirectory) throw new Error('KEY_INVALID_PATH');
    if (input.stage !== 'oF' && input.stage !== 'oS') throw new Error('KEY_STAGE_INVALID');
    const original = await this.store.read(input.keyPath);
    if (original === null) throw new Error('KEY_SOURCE_MISSING');
    let parsed: { candidates: KeyCandidate[] };
    let legacy = false;
    try { parsed = JSON.parse(original); }
    catch {
      const converted = parseLegacyKey(original);
      parsed = { candidates: converted.items };
      legacy = true;
    }
    if (!Array.isArray(parsed.candidates)) throw new Error('KEY_SOURCE_INVALID');
    const merged = new Map<string, KeyCandidate>();
    for (const item of [...parsed.candidates, ...input.candidates]) {
      if (!item || !safe(item.id) || !['head','body','footer'].includes(item.target) || !item.source || !item.description || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('KEY_CANDIDATE_INVALID');
      const key = item.target + ':' + item.id;
      const old = merged.get(key);
      if (!old || item.confidence > old.confidence) merged.set(key, item);
    }
    const all = [...merged.values()].sort((a,b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
    // Never silently discard uncertain or blocked candidates to meet a display cap.
    // Archive only explicitly high-confidence, unblocked entries, retaining a full ledger.
    const pending = all.filter(x => x.blocked || x.confidence < 0.8);
    const ready = all.filter(x => !x.blocked && x.confidence >= 0.8);
    const active = all.length > 10 ? [...pending, ...ready.slice(0, Math.max(0, 5 - pending.length))] : all;
    const archived = all.length > 10 ? ready.filter(x => !active.includes(x)) : [];
    const next = legacy ? appendLegacyProposals(original, input.candidates, input.transactionId) : JSON.stringify({ ...parsed, candidates: active, archived: [...((parsed as any).archived ?? []), ...archived] }, null, 2) + '\n';
    const base = input.seedDirectory.replace(/\/$/, '') + '/key_' + input.transactionId;
    const mutations: { path: string; sha256: string }[] = [];
    const commit = async (path: string, value: string) => {
      const existing = await this.store.read(path);
      if (existing !== null && existing !== value) throw new Error('KEY_TRANSACTION_CONFLICT');
      if (existing === null) await this.store.writeNew(path, value);
      if (await this.store.read(path) !== value) throw new Error('KEY_READBACK_FAILED');
      mutations.push({ path, sha256: hash(value) });
    };
    // Immutable transaction outputs; provider must implement writeNew as create-if-absent.
    await commit(base + '.temp_key.json', next);
    if (input.stage === 'oS') {
      for (const target of ['head','body','footer'] as const) {
        // These are proposals only; no canonical seed is promoted without Footer validation.
        const items = all.filter(x => x.target === target && !x.blocked);
        if (!items.length) continue;
        await commit(base + '.' + target + '.seed.json', JSON.stringify({
          schema: 'nyx.key.seed.proposal.v1', target, transactionId: input.transactionId,
          status: 'pending_validation', candidates: items,
          source: { keyPath: input.keyPath, sha256: hash(original) },
        }, null, 2) + '\n');
      }
    }
    await commit(base + '.receipt.json', JSON.stringify({
      schema: 'nyx.key.transaction.v1', stage: input.stage, scope: input.scope,
      beforeSha256: hash(original), afterSha256: hash(next), mutations,
      dispositions: { active: active.map(x=>x.id), archived: archived.map(x=>x.id) },
      diff: { before: original, after: next },
    }, null, 2) + '\n');
    // Does not overwrite active temp_key: promotion requires provider-backed CAS and Footer checkpoint.
    return { status: 'STAGED', stage: input.stage, mutations, activeCount: active.length, archivedCount: archived.length };
  }
}
