import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { cliSchema, Cli, Locator, parseJson } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
import { NyxHeadLibraryService } from './head-library.service';
@Injectable()
export class NyxCliRegistryService {
  private cache?: { fingerprint: string; cli: Cli; hash: string };
  private pending?: Promise<{ cli: Cli; hash: string }>;
  constructor(private readonly store: NyxResourceStore, private readonly head: NyxHeadLibraryService) {}
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
        if (!fingerprint) throw new Error();
        const member = await this.head.readMember(locator.cli, fingerprint, providerHashes);
        text = member.text;
        raw = Buffer.alloc(0);
      } else {
        text = await this.store.read(locator.cli);
        raw = Buffer.from(text);
        if (locator.cli.sha256 && sha256(text) !== locator.cli.sha256) throw new Error();
        for (const algorithm of ['sha256', 'sha1', 'md5']) {
          const expected = providerHashes[algorithm];
          if (expected && createHash(algorithm).update(raw).digest('hex') !== expected.toLowerCase()) throw new Error();
        }
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
