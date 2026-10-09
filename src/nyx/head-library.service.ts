import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ResourceRef } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
const AdmZip = require('adm-zip');

type HeadRef = ResourceRef & { member?: string; sha256?: string };

@Injectable()
export class NyxHeadLibraryService {
  private cache?: { fingerprint: string; bytes: Buffer; zip: any; sha256: string; loadedAt: string };

  constructor(private readonly store: NyxResourceStore) {}

  async readMember(ref: HeadRef, fingerprint: string, providerHashes: Record<string, string> = {}) {
    if (!ref.member) throw new Error('HEAD_MEMBER_REQUIRED');
    let cached = this.cache;
    if (!cached || cached.fingerprint !== fingerprint) {
      const bytes = await this.store.bytes(ref);
      if (ref.sha256 && sha256(bytes) !== ref.sha256) throw new Error('HEAD_HASH_MISMATCH');
      for (const algorithm of ['sha256', 'sha1', 'md5']) {
        const expected = providerHashes[algorithm];
        if (expected && createHash(algorithm).update(bytes).digest('hex') !== expected.toLowerCase()) throw new Error('HEAD_PROVIDER_HASH_MISMATCH');
      }
      cached = { fingerprint, bytes, zip: new AdmZip(bytes), sha256: sha256(bytes), loadedAt: new Date().toISOString() };
      this.cache = cached;
    }
    const entries = cached.zip.getEntries().filter((entry: any) => entry.entryName === ref.member);
    if (entries.length !== 1 || entries[0].header.size > 2 * 1024 * 1024) throw new Error('HEAD_MEMBER_INVALID');
    const data = entries[0].getData() as Buffer;
    return {
      data,
      text: data.toString('utf8'),
      library: {
        source: 'canonical-head',
        container_sha256: cached.sha256,
        cached: true,
        loaded_at: cached.loadedAt,
        member: ref.member,
      },
    };
  }

  snapshot() {
    if (!this.cache) return { loaded: false as const };
    return {
      loaded: true as const,
      sha256: this.cache.sha256,
      bytes: this.cache.bytes.length,
      loaded_at: this.cache.loadedAt,
    };
  }
}
