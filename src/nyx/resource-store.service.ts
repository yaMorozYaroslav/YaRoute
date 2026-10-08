import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RcloneService } from '../storage/rclone.service';
import { SharedRootsService } from '../storage/shared-roots.service';
import { ResourceRef } from './runtime.schema';
export function sha256(data: string | Buffer) { return createHash('sha256').update(data).digest('hex'); }

@Injectable()
export class NyxResourceStore {
  constructor(private readonly roots: SharedRootsService, private readonly rclone: RcloneService) {}
  private target(ref: ResourceRef) {
    if (ref.path.includes('\\') || ref.path.split('/').some(x => x === '..') || /[\x00-\x1f]/.test(ref.path)) throw new Error('INVALID_RESOURCE_PATH');
    return this.roots.resolve(ref.area, ref.path);
  }
  async stat(ref: ResourceRef): Promise<Record<string, any>> {
    try { return await this.rclone.json(['lsjson', this.target(ref), '--stat', '--hash']) as Record<string, any>; }
    catch { throw new Error('RESOURCE_STAT_FAILED'); }
  }
  async read(ref: ResourceRef, maxBytes = 2 * 1024 * 1024): Promise<string> {
    // Bound the actual stream instead of a separate size lookup, which cannot protect against a read race.
    // rclone cat rejects folders; the subprocess is killed if its output exceeds this limit.
    try {
      const { stdout } = await this.rclone.run(['cat', this.target(ref)], maxBytes);
      if (Buffer.byteLength(stdout) > maxBytes) throw new Error();
      return stdout;
    } catch { throw new Error('RESOURCE_READ_FAILED'); }
  }
  async bytes(ref: ResourceRef, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
    const stat = await this.stat(ref);
    if (stat.IsDir || stat.Size < 0 || stat.Size > maxBytes) throw new Error('RESOURCE_SIZE_UNSUPPORTED');
    const directory = await mkdtemp(path.join(tmpdir(), 'nyx-read-'));
    try {
      const local = path.join(directory, 'source');
      await this.rclone.run(['copyto', this.target(ref), local]);
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(local);
      if (bytes.length > maxBytes) throw new Error();
      return bytes;
    } catch { throw new Error('RESOURCE_READ_FAILED'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async optionalRead(ref: ResourceRef): Promise<string | undefined> {
    // Distinguish absence from access/transient errors; never overwrite on an uncertain read.
    try {
      const { stdout } = await this.rclone.run(['cat', this.target(ref)], 2 * 1024 * 1024);
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error('RESOURCE_SIZE_UNSUPPORTED');
      return stdout;
    }
    catch (error) {
      if (error instanceof Error && /^rclone exited [34]:/.test(error.message) && /not found|doesn't exist|directory not found|object not found/i.test(error.message)) return undefined;
      throw new Error('RESOURCE_LOOKUP_FAILED');
    }
  }
  async optionalList(ref: ResourceRef): Promise<Array<{ Name: string; IsDir: boolean }>> {
    try {
      const result = await this.rclone.json(['lsjson', this.target(ref)]);
      if (!Array.isArray(result)) throw new Error('INVALID_LIST');
      return result;
    } catch (error) {
      if (error instanceof Error && /^rclone exited [34]:/.test(error.message) && /directory not found|doesn't exist|not found/i.test(error.message)) return [];
      throw new Error('LINEAGE_LIST_FAILED');
    }
  }
  async createVerified(ref: ResourceRef, text: string, lookup?: { existing: string | undefined }) {
    // Recovery callers already checked this exact path inside the lineage lock. The immutable checksum
    // transfer and readback still protect against a destination appearing after that lookup.
    const existing = lookup ? lookup.existing : await this.optionalRead(ref);
    if (existing !== undefined) {
      if (existing !== text) throw new Error('IMMUTABLE_ARTIFACT_CONFLICT');
      return { sha256: sha256(text), verified: true as const };
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'nyx-write-'));
    try {
      const file = path.join(directory, 'artifact.json');
      await writeFile(file, text, { mode: 0o600 });
      await this.rclone.run(['copyto', file, this.target(ref), '--immutable', '--checksum']);
      if (await this.read(ref) !== text) throw new Error('ARTIFACT_READBACK_MISMATCH');
      return { sha256: sha256(text), verified: true as const };
    } catch { throw new Error('ARTIFACT_WRITE_VERIFY_FAILED'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
