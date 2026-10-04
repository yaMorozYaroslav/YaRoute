import { BadRequestException, Injectable } from '@nestjs/common';
import path from 'node:path';
import { SharedRoot } from './storage.types';

@Injectable()
export class SharedRootsService {
  private readonly roots: Record<string, SharedRoot>;

  constructor() {
    const raw = process.env.NYX_SHARED_ROOTS_JSON;
    if (!raw) throw new Error('NYX_SHARED_ROOTS_JSON is required');

    const parsed = JSON.parse(raw) as Record<string, SharedRoot>;
    for (const [name, config] of Object.entries(parsed)) {
      if (!name || !config?.remote || !config?.root) {
        throw new Error(`Invalid shared root config for ${name || '<empty>'}`);
      }
    }
    this.roots = parsed;
  }

  listAreas() {
    return Object.keys(this.roots).sort();
  }

  get(area: string): SharedRoot {
    const root = this.roots[area];
    if (!root) throw new BadRequestException(`Unknown shared area: ${area}`);
    return root;
  }

  resolve(area: string, relativePath = ''): string {
    const root = this.get(area);
    const clean = this.cleanRelativePath(relativePath);
    const fullPath = clean ? path.posix.join(root.root, clean) : root.root;
    return `${root.remote}:${fullPath}`;
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
