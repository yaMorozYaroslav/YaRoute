import { BadRequestException, Injectable } from '@nestjs/common';
import path from 'node:path';
import { RcloneService } from './rclone.service';
import { SharedRootsService } from './shared-roots.service';
import { CopyJobPayload, StorageProvider } from './storage.types';

type AreaEntry = {
  alias: string;
  remote: string;
  root: string;
  provider?: StorageProvider;
  dynamic: boolean;
};

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

      let alias = `GDRIVE_${stem}`;
      let suffix = 2;
      while (usedAliases.has(alias)) {
        alias = `GDRIVE_${stem}_${suffix}`;
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
    const sharedDrives = await this.googleSharedDriveEntries();
    return [...explicit, ...dynamicMega, ...sharedDrives];
  }

  private async resolveAreaTarget(area: string, relativePath: string) {
    if (this.roots.listAreas().includes(area)) {
      return this.roots.resolve(area, relativePath);
    }

    const dynamic = [
      ...(await this.megaEntries()).filter((entry) => entry.dynamic),
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
    const fullPath = clean ? path.posix.join(entry.root, clean) : entry.root;
    return `${entry.remote}:${fullPath}`;
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
