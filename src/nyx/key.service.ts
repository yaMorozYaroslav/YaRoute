import { Injectable } from '@nestjs/common';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { KeyEngine, KeyStore, KeyCandidate, KeyStage } from './key-engine';
import { NyxResourceStore } from './resource-store.service';
import { ResourceRef } from './runtime.schema';

/** Provider choice is deployment configuration, not a CLI semantic. */
@Injectable()
export class NyxKeyService {
  constructor(private readonly resources: NyxResourceStore) {}
  private adapter(): KeyStore {
    const provider = process.env.NYX_KEY_STORAGE_PROVIDER;
    if (provider === 'local') {
      const root = process.env.NYX_KEY_LOCAL_ROOT;
      if (!root || !path.isAbsolute(root)) throw new Error('KEY_LOCAL_ROOT_REQUIRED');
      const resolve = (name: string) => {
        if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/')) throw new Error('KEY_INVALID_PATH');
        const dest = path.resolve(root, name);
        if (!dest.startsWith(path.resolve(root) + path.sep)) throw new Error('KEY_INVALID_PATH');
        return dest;
      };
      return {
        read: async name => { try { return await readFile(resolve(name),'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
        writeNew: async (name, content) => {
          const dest = resolve(name);
          await mkdir(path.dirname(dest), { recursive: true });
          const handle = await open(dest, 'wx', 0o600);
          try { await handle.writeFile(content,'utf8'); } finally { await handle.close(); }
        },
      };
    }
    if (provider === 'rclone') {
      const area = process.env.NYX_KEY_AREA;
      const prefix = process.env.NYX_KEY_PREFIX;
      if (!area || !prefix || !/^[a-zA-Z0-9_./-]+$/.test(prefix)) throw new Error('KEY_RCLONE_CONFIG_REQUIRED');
      const ref = (name: string): ResourceRef => {
        if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..')) throw new Error('KEY_INVALID_PATH');
        return { area, path: path.posix.join(prefix, name) };
      };
      return {
        read: async name => (await this.resources.optionalRead(ref(name))) ?? null,
        writeNew: async (name, content) => {
          if (await this.resources.optionalRead(ref(name)) !== undefined) throw new Error('KEY_ALREADY_EXISTS');
          await this.resources.createVerified(ref(name), content);
        },
      };
    }
    throw new Error('KEY_PROVIDER_NOT_CONFIGURED');
  }
  async execute(input: { stage: KeyStage; scope?: 'local' | 'global'; candidates?: KeyCandidate[]; transactionId: string }) {
    if (!['oF','oS'].includes(input.stage)) throw new Error('KEY_STAGE_INVALID');
    const keyPath = process.env.NYX_KEY_ACTIVE_PATH;
    const seedDirectory = process.env.NYX_KEY_TRANSACTION_DIR;
    if (!keyPath || !seedDirectory) throw new Error('KEY_PATHS_NOT_CONFIGURED');
    return new KeyEngine(this.adapter()).execute({
      stage: input.stage, scope: input.scope ?? 'local', keyPath, seedDirectory,
      candidates: input.candidates ?? [], transactionId: input.transactionId,
    });
  }
}
