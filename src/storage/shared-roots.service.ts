import { BadRequestException, Injectable } from '@nestjs/common';
import path from 'node:path';
import { SharedRoot, StorageProvider } from './storage.types';

@Injectable()
export class SharedRootsService {
  private readonly roots: Record<string, SharedRoot>;

  constructor() {
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') {
      // Ignore any inherited operator-wide roots even when configured.
      this.roots={};
      return;
    }
    const raw = process.env.NYX_SHARED_ROOTS_JSON;
    if (!raw) throw new Error('NYX_SHARED_ROOTS_JSON is required');

    const parsed = JSON.parse(raw) as Record<string, SharedRoot>;
    const providers = new Set<StorageProvider>(['google-drive', 'mega', 'other']);

    for (const [name, config] of Object.entries(parsed)) {
      if (!name || !config?.remote || !config?.root) {
        throw new Error(`Invalid shared root config for ${name || '<empty>'}`);
      }
      if (config.provider && !providers.has(config.provider)) {
        throw new Error(`Invalid storage provider for ${name}: ${config.provider}`);
      }
    }
    this.roots = parsed;
  }

  listAreas(provider?: StorageProvider) {
    return Object.entries(this.roots)
      .filter(([, config]) => !provider || config.provider === provider)
      .map(([name]) => name)
      .sort();
  }

  get(area: string): SharedRoot {
    const root = this.roots[area];
    if (!root) throw new BadRequestException(`Unknown shared area: ${area}`);
    return root;
  }

  assertProvider(area: string, provider: StorageProvider) {
    const root = this.get(area);
    if (root.provider !== provider) {
      throw new BadRequestException(`${area} is not configured as provider ${provider}`);
    }
    return root;
  }

  resolve(area: string, relativePath = ''): string {
    const root = this.get(area);
    const clean = this.cleanRelativePath(relativePath);
    const base = root.root === '.' ? '' : root.root;
    const fullPath = clean ? path.posix.join(base, clean) : base;
    return fullPath ? `${root.remote}:${fullPath}` : `${root.remote}:`;
  }

  cleanRelativePath(value: string): string {
    if (typeof value !== 'string') throw new BadRequestException('path must be a string');
    if (value.includes('\0')) throw new BadRequestException('path contains NUL');
    if (value.startsWith('/')) throw new BadRequestException('path must be relative to the shared root');
    const normalized = path.posix.normalize(value || '.');
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new BadRequestException('path may not escape the shared root');
    }
    if (normalized.length > 2048) throw new BadRequestException('path is too long');
    return normalized === '.' ? '' : normalized;
  }
}
