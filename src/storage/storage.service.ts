import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RcloneService } from './rclone.service';
import { SharedRootsService } from './shared-roots.service';
import { CopyJobPayload, GlobalIndexJobPayload, StorageProvider } from './storage.types';

type AreaEntry = {
  alias: string;
  remote: string;
  root: string;
  provider?: StorageProvider;
  dynamic: boolean;
};

type RawListItem = {
  Path?: string;
  Name?: string;
  Size?: number;
  MimeType?: string;
  ModTime?: string;
  IsDir?: boolean;
  Hashes?: Record<string, string>;
};

const GLOBAL_INDEX_ROOT = 'Documents/Nyxpad/file_global_indexes';

@Injectable()
export class StorageService {
  constructor(
    private readonly roots: SharedRootsService,
    private readonly rclone: RcloneService,
  ) {}

  async areas() {
    return (await this.allAreaEntries()).map((entry) => entry.alias).sort();
  }

  async megaAreas() {
    return (await this.megaEntries()).map((entry) => entry.alias).sort();
  }

  validateCopyPayload(payload: CopyJobPayload) {
    this.validateFileRef(payload.source, 'source');
    this.validateFileRef(payload.destination, 'destination');

    const sourceProvider = this.roots.get(payload.source.area).provider;
    const destinationProvider = this.roots.get(payload.destination.area).provider;
    if (sourceProvider === 'mega' || destinationProvider === 'mega') {
      throw new BadRequestException(
        'MEGA copy/move is not enabled yet. Use the read-only MEGA tools until provider-specific verification is implemented.',
      );
    }
  }

  async capacity() {
    return this.capacityForEntries(await this.allAreaEntries());
  }

  async megaCapacity() {
    return this.capacityForEntries(await this.megaEntries());
  }

  async list(area: string, relativePath = '') {
    const target = await this.resolveAreaTarget(area, relativePath);
    return this.rclone.json(['lsjson', target, '--metadata', '--hash']);
  }

  async megaList(account: string, relativePath = '') {
    const target = await this.resolveMegaTarget(account, relativePath);
    return this.rclone.json(['lsjson', target, '--metadata', '--hash']);
  }

  async stat(area: string, relativePath: string) {
    const target = await this.resolveAreaTarget(area, relativePath);
    return this.statTarget(target);
  }

  async megaStat(account: string, relativePath: string) {
    const target = await this.resolveMegaTarget(account, relativePath);
    return this.statTarget(target);
  }

  async executeCopy(payload: CopyJobPayload) {
    this.validateCopyPayload(payload);

    const source = this.roots.resolve(payload.source.area, payload.source.path);
    const destination = this.roots.resolve(payload.destination.area, payload.destination.path);

    await this.rclone.run([
      'copyto', source, destination,
      '--immutable',
      '--stats=30s', '--stats-one-line', '--log-level=INFO',
    ]);

    const sourceStat = await this.statTarget(source);
    const destinationStat = await this.statTarget(destination);
    const verification = this.verify(sourceStat, destinationStat, payload.destination.area);

    if (payload.verify !== false && !verification.trusted) {
      throw new Error(`Copy completed but verification is not trusted: ${JSON.stringify(verification)}`);
    }

    return {
      source: payload.source,
      destination: payload.destination,
      sourceRetained: true,
      verification,
      destinationStat,
    };
  }

  async executeGlobalIndex(payload: GlobalIndexJobPayload = {}) {
    const generatedAt = new Date().toISOString();
    const scanId = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const entries = (await this.allAreaEntries()).sort((a, b) => a.alias.localeCompare(b.alias));
    const driveRemotes = new Set(await this.rclone.listRemoteNamesByType('drive'));
    const megaRemotes = new Set(await this.rclone.listRemoteNamesByType('mega'));

    const normalSources: any[] = [];
    const deepSources: any[] = [];
    const basicSources: any[] = [];

    let totalItems = 0;
    let totalFiles = 0;
    let totalDirs = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      const target = this.resolveEntryTarget(entry, '');
      const raw = await this.rclone.json([
        'lsjson',
        target,
        '--recursive',
        '--metadata',
        '--hash',
      ]);

      if (!Array.isArray(raw)) {
        throw new Error(`Global index scan returned non-array for ${entry.alias}`);
      }

      const items = (raw as RawListItem[])
        .filter((item) => {
          if (entry.alias !== 'MAIN') return true;
          const itemPath = String(item.Path || '').replace(/^\.\//, '');
          return itemPath !== GLOBAL_INDEX_ROOT && !itemPath.startsWith(`${GLOBAL_INDEX_ROOT}/`);
        })
        .sort((a, b) => String(a.Path || '').localeCompare(String(b.Path || '')));

      const files = items.filter((item) => !item.IsDir);
      const dirs = items.filter((item) => item.IsDir);
      const bytes = files.reduce((sum, item) => {
        const size = Number(item.Size);
        return sum + (Number.isFinite(size) && size > 0 ? size : 0);
      }, 0);

      totalItems += items.length;
      totalFiles += files.length;
      totalDirs += dirs.length;
      totalBytes += bytes;

      const baseRemote = entry.remote.split(',')[0];
      const provider =
        entry.provider ||
        (driveRemotes.has(baseRemote) ? 'google-drive' : megaRemotes.has(baseRemote) ? 'mega' : 'other');

      const normalItems = items.map((item) => ({
        path: String(item.Path || ''),
        type: item.IsDir ? 'directory' : 'file',
        size: this.toNumberOrNull(item.Size),
        modTime: item.ModTime || null,
        mimeType: item.MimeType || null,
      }));

      const deepItems = items.map((item) => {
        const itemPath = String(item.Path || '');
        const parent = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '';
        const name = String(item.Name || path.posix.basename(itemPath));
        const extension = item.IsDir ? null : (path.posix.extname(name).replace(/^\./, '').toLowerCase() || null);
        return {
          path: itemPath,
          name,
          parent,
          depth: itemPath ? itemPath.split('/').length : 0,
          type: item.IsDir ? 'directory' : 'file',
          size: this.toNumberOrNull(item.Size),
          modTime: item.ModTime || null,
          mimeType: item.MimeType || null,
          extension,
          hashes: this.normalizeHashes(item.Hashes),
        };
      });

      const topLevel = items
        .filter((item) => !String(item.Path || '').includes('/'))
        .map((item) => ({
          name: String(item.Name || item.Path || ''),
          type: item.IsDir ? 'directory' : 'file',
        }));

      basicSources.push({
        area: entry.alias,
        provider,
        items: items.length,
        files: files.length,
        directories: dirs.length,
        bytes,
        topLevel,
      });

      normalSources.push({
        area: entry.alias,
        provider,
        summary: { items: items.length, files: files.length, directories: dirs.length, bytes },
        items: normalItems,
      });

      deepSources.push({
        area: entry.alias,
        provider,
        summary: { items: items.length, files: files.length, directories: dirs.length, bytes },
        items: deepItems,
      });
    }

    const totals = {
      sources: entries.length,
      items: totalItems,
      files: totalFiles,
      directories: totalDirs,
      bytes: totalBytes,
    };

    const normalIndex = {
      schema: 'nyx.file_global_index.normal.v1',
      role: 'file_global_index',
      depth: 'normal',
      generatedAt,
      scanId,
      contentPolicy: 'metadata-only; no file contents or credentials read',
      totals,
      sources: normalSources,
    };

    const deepIndex = {
      schema: 'nyx.file_global_index.deep.v1',
      role: 'file_global_index',
      depth: 'deep',
      generatedAt,
      scanId,
      contentPolicy: 'metadata-only; no file contents, external object IDs, owner emails, or credentials stored',
      totals,
      sources: deepSources,
    };

    const basicLines = [
      '# NYX File Global Index',
      '',
      `Generated: ${generatedAt}`,
      `Scan: ${scanId}`,
      `Sources: ${totals.sources}`,
      `Items: ${totals.items} (${totals.files} files, ${totals.directories} directories)`,
      `Indexed file bytes: ${totals.bytes}`,
      '',
      '> Metadata-only global inventory. File contents and credentials were not read.',
      '> Current machine indexes: global.md (Basic), n_global.json (Normal), d_global.json (Deep).',
      '',
    ];

    for (const source of basicSources) {
      basicLines.push(
        `## ${source.area}`,
        '',
        `- Provider: ${source.provider}`,
        `- Items: ${source.items}`,
        `- Files: ${source.files}`,
        `- Directories: ${source.directories}`,
        `- Indexed file bytes: ${source.bytes}`,
        '- Top level:',
      );
      for (const item of source.topLevel) {
        basicLines.push(`  - ${item.type === 'directory' ? '📁' : '📄'} ${item.name}`);
      }
      if (!source.topLevel.length) basicLines.push('  - (empty)');
      basicLines.push('');
    }

    const globalMd = `${basicLines.join('\n').trimEnd()}\n`;
    const normalJson = `${JSON.stringify(normalIndex)}\n`;
    const deepJson = `${JSON.stringify(deepIndex)}\n`;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-global-index-'));
    try {
      const localFiles = [
        { name: 'global.md', content: globalMd },
        { name: 'n_global.json', content: normalJson },
        { name: 'd_global.json', content: deepJson },
      ];

      const generated = localFiles.map((file) => {
        const localPath = path.join(tempDir, file.name);
        fs.writeFileSync(localPath, file.content, 'utf8');
        return {
          ...file,
          localPath,
          bytes: Buffer.byteLength(file.content),
          sha256: createHash('sha256').update(file.content).digest('hex'),
        };
      });

      const currentRoot = this.roots.resolve('MAIN', GLOBAL_INDEX_ROOT);
      await this.rclone.run(['mkdir', currentRoot]);

      let snapshotRoot: string | null = null;
      if (payload.snapshot !== false) {
        snapshotRoot = this.roots.resolve('MAIN', `${GLOBAL_INDEX_ROOT}/versions/${scanId}`);
        await this.rclone.run(['mkdir', snapshotRoot]);
        for (const file of generated) {
          await this.rclone.run(['copyto', file.localPath, this.roots.resolve('MAIN', `${GLOBAL_INDEX_ROOT}/versions/${scanId}/${file.name}`)]);
        }
      }

      const verification: any[] = [];
      for (const file of generated) {
        const remotePath = this.roots.resolve('MAIN', `${GLOBAL_INDEX_ROOT}/${file.name}`);
        await this.rclone.run(['copyto', file.localPath, remotePath]);
        const stat = await this.statTarget(remotePath);
        const remoteSize = Number(stat?.Size);
        const remoteSha = this.normalizeHashes(stat?.Hashes).sha256 || null;
        const sizeMatch = remoteSize === file.bytes;
        const hashMatch = remoteSha ? remoteSha === file.sha256 : null;
        verification.push({
          file: file.name,
          bytes: file.bytes,
          sha256: file.sha256,
          sizeMatch,
          hashMatch,
          trusted: Boolean(sizeMatch && (hashMatch === null || hashMatch)),
        });
      }

      if (verification.some((item) => !item.trusted)) {
        throw new Error(`Global index upload verification failed: ${JSON.stringify(verification)}`);
      }

      return {
        schema: 'nyx.file_global_index.receipt.v1',
        generatedAt,
        scanId,
        destination: {
          area: 'MAIN',
          root: GLOBAL_INDEX_ROOT,
          current: ['global.md', 'n_global.json', 'd_global.json'],
          snapshot: payload.snapshot === false ? null : `versions/${scanId}`,
        },
        totals,
        sources: basicSources.map(({ topLevel, ...source }) => source),
        verification,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private explicitEntries(): AreaEntry[] {
    return this.roots.listAreas().map((alias) => {
      const root = this.roots.get(alias);
      return {
        alias,
        remote: root.remote,
        root: root.root,
        provider: root.provider,
        dynamic: false,
      };
    });
  }

  private async megaEntries(): Promise<AreaEntry[]> {
    const explicit = this.explicitEntries().filter((entry) => entry.provider === 'mega');
    const explicitMegaRemotes = new Set(explicit.map((entry) => entry.remote));
    const usedAliases = new Set(this.roots.listAreas());
    const discovered = await this.rclone.listRemoteNamesByType('mega');

    const dynamic: AreaEntry[] = [];
    let index = 1;

    for (const remote of discovered) {
      if (explicitMegaRemotes.has(remote)) continue;
      while (usedAliases.has(`MEGA_${index}`)) index += 1;

      const alias = `MEGA_${index}`;
      usedAliases.add(alias);
      dynamic.push({
        alias,
        remote,
        root: '.',
        provider: 'mega',
        dynamic: true,
      });
      index += 1;
    }

    return [...explicit, ...dynamic].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  private async googleRemoteEntries(): Promise<AreaEntry[]> {
    const mainRemote = this.roots.get('MAIN').remote;
    const discovered = (await this.rclone.listRemoteNamesByType('drive'))
      .filter((remote) => remote !== mainRemote);

    const usedAliases = new Set([
      ...this.roots.listAreas(),
      ...(await this.megaEntries()).map((entry) => entry.alias),
    ]);

    const entries: AreaEntry[] = [];
    let index = 1;
    for (const remote of discovered) {
      while (usedAliases.has(`GDRIVE_${index}`)) index += 1;
      const alias = `GDRIVE_${index}`;
      usedAliases.add(alias);
      entries.push({
        alias,
        remote,
        root: '.',
        provider: 'google-drive',
        dynamic: true,
      });
      index += 1;
    }

    return entries;
  }

  private async googleSharedDriveEntries(): Promise<AreaEntry[]> {
    const main = this.roots.get('MAIN');
    const discovered = await this.rclone.listGoogleSharedDrives(main.remote);
    const usedAliases = new Set([
      ...this.roots.listAreas(),
      ...(await this.megaEntries()).map((entry) => entry.alias),
    ]);

    const entries: AreaEntry[] = [];
    for (const drive of discovered) {
      const stem = drive.name
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase()
        .slice(0, 48) || 'DRIVE';

      let alias = `SHAREDDRIVE_${stem}`;
      let suffix = 2;
      while (usedAliases.has(alias)) {
        alias = `SHAREDDRIVE_${stem}_${suffix}`;
        suffix += 1;
      }
      usedAliases.add(alias);

      entries.push({
        alias,
        remote: `${main.remote},team_drive=${drive.id},root_folder_id=`,
        root: '.',
        provider: 'google-drive',
        dynamic: true,
      });
    }

    return entries.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  private async allAreaEntries(): Promise<AreaEntry[]> {
    const explicit = this.explicitEntries();
    const dynamicMega = (await this.megaEntries()).filter((entry) => entry.dynamic);
    const googleRemotes = await this.googleRemoteEntries();
    const sharedDrives = await this.googleSharedDriveEntries();
    return [...explicit, ...dynamicMega, ...googleRemotes, ...sharedDrives];
  }

  private async resolveAreaTarget(area: string, relativePath: string) {
    if (this.roots.listAreas().includes(area)) {
      return this.roots.resolve(area, relativePath);
    }

    const dynamic = [
      ...(await this.megaEntries()).filter((entry) => entry.dynamic),
      ...(await this.googleRemoteEntries()),
      ...(await this.googleSharedDriveEntries()),
    ];
    const entry = dynamic.find((candidate) => candidate.alias === area);
    if (!entry) throw new BadRequestException(`Unknown shared area: ${area}`);
    return this.resolveEntryTarget(entry, relativePath);
  }

  private async resolveMegaTarget(account: string, relativePath: string) {
    const entry = (await this.megaEntries()).find((candidate) => candidate.alias === account);
    if (!entry) throw new BadRequestException(`Unknown MEGA account alias: ${account}`);
    return this.resolveEntryTarget(entry, relativePath);
  }

  private resolveEntryTarget(entry: AreaEntry, relativePath: string) {
    const clean = this.roots.cleanRelativePath(relativePath);
    const base = entry.root === '.' ? '' : entry.root;
    const fullPath = clean ? path.posix.join(base, clean) : base;
    return fullPath ? `${entry.remote}:${fullPath}` : `${entry.remote}:`;
  }

  private async capacityForEntries(entries: AreaEntry[]) {
    const remoteAreas = new Map<string, string[]>();

    for (const entry of entries) {
      const mappedAreas = remoteAreas.get(entry.remote) || [];
      mappedAreas.push(entry.alias);
      remoteAreas.set(entry.remote, mappedAreas);
    }

    const remotes = await Promise.all(
      Array.from(remoteAreas.entries()).map(async ([remote, mappedAreas]) => {
        try {
          const about = await this.rclone.json(['about', `${remote}:`, '--json']) as any;
          return {
            areas: mappedAreas.sort(),
            total: this.toNumberOrNull(about?.total),
            used: this.toNumberOrNull(about?.used),
            free: this.toNumberOrNull(about?.free),
            trashed: this.toNumberOrNull(about?.trashed),
            other: this.toNumberOrNull(about?.other),
            error: null,
          };
        } catch (error) {
          return {
            areas: mappedAreas.sort(),
            total: null,
            used: null,
            free: null,
            trashed: null,
            other: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const readable = remotes.filter((item) => item.error === null);
    return {
      areas: entries.map((entry) => entry.alias).sort(),
      remotes,
      aggregate: {
        total: this.sumKnown(readable.map((item) => item.total)),
        used: this.sumKnown(readable.map((item) => item.used)),
        free: this.sumKnown(readable.map((item) => item.free)),
      },
      note: 'Capacity is account/remote quota. Dynamic aliases expose only storage already available to the authenticated runtime account.',
    };
  }

  private validateFileRef(ref: CopyJobPayload['source'], label: string) {
    if (!ref?.area || !ref?.path) throw new BadRequestException(`${label}.area and ${label}.path are required`);
    this.roots.get(ref.area);
    const clean = this.roots.cleanRelativePath(ref.path);
    if (!clean) throw new BadRequestException(`${label}.path must identify a file below the shared root`);
  }

  private async statTarget(target: string): Promise<any> {
    return this.rclone.json(['lsjson', target, '--stat', '--metadata', '--hash']);
  }

  private verify(source: any, destination: any, destinationArea: string) {
    const sourceHashes = this.normalizeHashes(source?.Hashes);
    const destinationHashes = this.normalizeHashes(destination?.Hashes);
    const common = Object.keys(sourceHashes).find((key) => destinationHashes[key]);
    const sizeMatch = Number(source?.Size) === Number(destination?.Size);
    const hashMatch = common ? sourceHashes[common] === destinationHashes[common] : false;
    const destinationOwner = destination?.Metadata?.owner;
    const expectedOwner = this.roots.get(destinationArea).expectedOwner;
    const ownerMatch = expectedOwner ? destinationOwner === expectedOwner : false;

    return {
      sizeMatch,
      hashAlgorithm: common || null,
      hashMatch: common ? hashMatch : null,
      destinationOwner: destinationOwner || null,
      expectedOwner: expectedOwner || null,
      ownerMatch: expectedOwner ? ownerMatch : null,
      trusted: Boolean(sizeMatch && common && hashMatch && expectedOwner && ownerMatch),
    };
  }

  private normalizeHashes(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, hash]) => typeof hash === 'string' && hash.length > 0)
        .map(([name, hash]) => [name.toLowerCase(), String(hash)]),
    );
  }

  private toNumberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private sumKnown(values: Array<number | null>): number | null {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  }
}
