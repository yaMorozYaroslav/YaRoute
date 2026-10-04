import { BadRequestException, Injectable } from '@nestjs/common';
import { RcloneService } from './rclone.service';
import { SharedRootsService } from './shared-roots.service';
import { CopyJobPayload } from './storage.types';

@Injectable()
export class StorageService {
  constructor(
    private readonly roots: SharedRootsService,
    private readonly rclone: RcloneService,
  ) {}

  areas() {
    return this.roots.listAreas();
  }

  validateCopyPayload(payload: CopyJobPayload) {
    this.validateFileRef(payload.source, 'source');
    this.validateFileRef(payload.destination, 'destination');
  }

  async capacity() {
    const areas = this.roots.listAreas();
    const remoteAreas = new Map<string, string[]>();

    for (const area of areas) {
      const remote = this.roots.get(area).remote;
      const mappedAreas = remoteAreas.get(remote) || [];
      mappedAreas.push(area);
      remoteAreas.set(remote, mappedAreas);
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
      areas,
      remotes,
      aggregate: {
        total: this.sumKnown(readable.map((item) => item.total)),
        used: this.sumKnown(readable.map((item) => item.used)),
        free: this.sumKnown(readable.map((item) => item.free)),
      },
      note: 'Capacity is account/remote quota. File operations remain restricted to configured shared-folder roots.',
    };
  }

  async list(area: string, relativePath = '') {
    const target = this.roots.resolve(area, relativePath);
    return this.rclone.json(['lsjson', target, '--metadata', '--hash']);
  }

  async stat(area: string, relativePath: string) {
    const target = this.roots.resolve(area, relativePath);
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
