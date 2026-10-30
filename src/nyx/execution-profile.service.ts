import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { Cli, Locator, parseJson, profileSchema } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
import { assertRuntimePinBoundary } from './runtime-pin-repair';

@Injectable()
export class NyxExecutionProfileService {
  constructor(private readonly store: NyxResourceStore) {}
  async inspectMaintenanceTarget(locator: Locator, text: string, cliHash: string) {
    const configured = await this.profileText(locator);
    if (configured === undefined) throw new Error('MAINTENANCE_CONFIGURED_PROFILE_REQUIRED');
    // Validate every source definition before making any target-directed private read.
    assertRuntimePinBoundary(configured, text);
    return this.inspectText(text, cliHash);
  }
  /** Private diagnostics only: never reconcile pins or return source contents. */
  async inspect(locator: Locator, cliHash: string) {
    try {
      const text = await this.profileText(locator);
      if (text === undefined) return { ready: true, configured: false, driftDetected: false, keys: [] };
      return this.inspectText(text, cliHash);
    } catch {
      return { ready: false, configured: true, error: 'EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE', keys: [] };
    }
  }
  async inspectText(text: string, cliHash: string) {
    try {
      const profile = profileSchema.parse(parseJson(text));
      const keys = [];
      for (const source of profile.keySources) {
        try {
          const actual = sha256(await this.store.read(source.ref, 256 * 1024));
          keys.push({ key: source.key, mode: source.mode, expected: source.sha256, actual,
            status: actual === source.sha256 ? 'verified' : 'changed' });
        } catch { keys.push({ key: source.key, mode: source.mode, expected: source.sha256, status: 'unavailable' }); }
      }
      const authorityMatches = profile.cliSha256 === cliHash;
      return { ready: authorityMatches && keys.every(key => key.mode === 'observe' || key.status === 'verified'),
        driftDetected: keys.some(key => key.status !== 'verified'), configured: true, profileSha256: sha256(text), authorityMatches,
        expectedCliSha256: profile.cliSha256, actualCliSha256: cliHash, keys };
    } catch {
      return { ready: false, configured: true, error: 'EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE', keys: [] };
    }
  }
  private async profileText(locator: Locator): Promise<string | undefined> {
    const deployedPath = process.env.NYX_RUNTIME_PROFILE_PATH ?? (process.env.DYNO ? 'config/nyx-runtime-profile.json' : undefined);
    if (deployedPath) return readFile(deployedPath, 'utf8');
    if (locator.executionProfile) return this.store.read(locator.executionProfile, 128 * 1024);
    return undefined;
  }
  async apply(locator: Locator, cli: Cli, cliHash: string): Promise<{ cli: Cli; hash?: string; keyReceipts?: Array<{ key: string; sha256: string }>; keyWarnings?: string[] }> {
    try {
      const text = await this.profileText(locator);
      return text === undefined ? { cli, keyReceipts: [], keyWarnings: [] } : await this.applyText(text, cli, cliHash);
    }
    catch (error) { this.rethrowProfileError(error); }
  }
  private rethrowProfileError(error: unknown): never {
    if (error instanceof Error && error.message.startsWith('KEY_PREFLIGHT_')) throw error;
    throw new Error('EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE');
  }
  private async applyText(text: string, cli: Cli, cliHash: string) {
    // Operational execution bindings are explicit runtime configuration, not new canonical command definitions.
    // The canonical CLI is checked first; profile bindings cannot add commands or aliases.
    const profile = profileSchema.parse(parseJson(text));
    if (profile.cliSha256 !== cliHash) throw new Error('PROFILE_AUTHORITY_CHANGED');
    // Enforce trusted pins fail-closed. Mutable, non-executable staging overlays are
    // diagnostic-only: they cannot change canonical CLI authority or execution routes.
    // Never promote an observed hash or execute text from an observed overlay.
    const keyReceipts: Array<{ key: string; sha256: string }> = [];
    const keyWarnings: string[] = [];
    for (const source of profile.keySources) {
      let content: string;
      try { content = await this.store.read(source.ref, 256 * 1024); }
      catch {
        if (source.mode === 'observe') {
          keyWarnings.push(`KEY_OBSERVE_SOURCE_UNAVAILABLE:${source.key}`);
          continue;
        }
        throw new Error(`KEY_PREFLIGHT_SOURCE_UNAVAILABLE:${source.key}`);
      }
      const actual = sha256(content);
      if (actual !== source.sha256) {
        if (source.mode === 'observe') {
          keyWarnings.push(`KEY_OBSERVE_CHANGED_REQUIRES_REVIEW:${source.key}`);
          continue;
        }
        throw new Error(`KEY_PREFLIGHT_CHANGED_REQUIRES_CHATGPT:${source.key}`);
      }
      keyReceipts.push({ key: source.key, sha256: actual });
    }
    const commands = { ...cli.commands };
    for (const [name, execution] of Object.entries(profile.commands)) {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error('PROFILE_COMMAND_NOT_CANONICAL');
      commands[name] = { ...commands[name], execution };
    }
    return { cli: { ...cli, commands }, hash: sha256(text), keyReceipts, keyWarnings };
  }
}
