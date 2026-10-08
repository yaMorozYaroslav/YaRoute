import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { cliSchema, Cli, Locator, parseJson } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
const AdmZip = require('adm-zip');
@Injectable()
export class NyxCliRegistryService {
  private cache?: { fingerprint: string; cli: Cli; hash: string };
  private pending?: Promise<{ cli: Cli; hash: string }>;
  constructor(private readonly store: NyxResourceStore) {}
  async current(locator: Locator): Promise<{ cli: Cli; hash: string }> {
    // A fresh stat is mandatory even if another request is resolving the same authority.
    const stat = await this.store.stat(locator.cli);
    const hashes = stat.Hashes ?? {};
    const reliableHash = hashes.sha256 || hashes.sha1 || hashes.md5;
    const fingerprint = reliableHash ? sha256(JSON.stringify([locator.cli, stat.ID, stat.Size, reliableHash])) : undefined;
    if (fingerprint && this.cache?.fingerprint === fingerprint) return { cli: this.cache.cli, hash: this.cache.hash };
    // No provider hash -> re-read bytes; mtime/size alone never certify unchanged authority.
    if (this.pending) { await this.pending; return this.current(locator); }
    const load = this.load(locator, fingerprint, hashes);
    this.pending = load;
    try { return await load; } finally { this.pending = undefined; }
  }
  private async load(locator: Locator, fingerprint?: string, providerHashes: Record<string, string> = {}) {
    this.cache = undefined; // Invalid changed CLI must never fall back to an old command cache.
    try {
      let text: string;
      let raw: Buffer;
      if (locator.cli.member) {
        const bytes = await this.store.bytes(locator.cli);
        raw = bytes;
        if (!locator.cli.sha256 || sha256(bytes) !== locator.cli.sha256) throw new Error();
        const zip = new AdmZip(bytes);
        const entries = zip.getEntries().filter((e: any) => e.entryName === locator.cli.member);
        if (entries.length !== 1 || entries[0].header.size > 2 * 1024 * 1024) throw new Error();
        text = entries[0].getData().toString('utf8');
      } else {
        text = await this.store.read(locator.cli);
        raw = Buffer.from(text);
        if (locator.cli.sha256 && sha256(text) !== locator.cli.sha256) throw new Error();
      }
      for (const algorithm of ['sha256', 'sha1', 'md5']) {
        const expected = providerHashes[algorithm];
        if (expected && createHash(algorithm).update(raw!).digest('hex') !== expected.toLowerCase()) throw new Error();
      }
      const cli = cliSchema.parse(parseJson(text));
      if (!Object.keys(cli.commands).length) throw new Error();
      const names = new Set(Object.keys(cli.commands).map(x => x.toLowerCase()));
      if (names.size !== Object.keys(cli.commands).length) throw new Error();
      for (const command of Object.values(cli.commands)) for (const alias of command.aliases ?? []) {
        if (names.has(alias.toLowerCase())) throw new Error();
        names.add(alias.toLowerCase());
      }
      const hash = sha256(text);
      if (fingerprint) this.cache = { fingerprint, cli, hash };
      return { cli, hash };
    } catch { throw new Error('CLI_INVALID_OR_UNAVAILABLE'); }
  }
}
