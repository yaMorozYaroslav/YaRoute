import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { Cli, Locator, parseJson, profileSchema } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';

@Injectable()
export class NyxExecutionProfileService {
  constructor(private readonly store: NyxResourceStore) {}
  async apply(locator: Locator, cli: Cli, cliHash: string): Promise<{ cli: Cli; hash?: string }> {
    const deployedPath = process.env.NYX_RUNTIME_PROFILE_PATH ?? (process.env.DYNO ? 'config/nyx-runtime-profile.json' : undefined);
    if (deployedPath) {
      try { return await this.applyText(await readFile(deployedPath, 'utf8'), cli, cliHash); }
      catch (error) { this.rethrowProfileError(error); }
    }
    if (!locator.executionProfile) return { cli };
    try { return await this.applyText(await this.store.read(locator.executionProfile, 128 * 1024), cli, cliHash); }
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
    // Read and hash the active, explicitly pinned keys before resolving any command.
    // Arbitrary text keys must never be evaluated as backend code. If their bytes change,
    // fail closed so ChatGPT can apply/reconcile the accepted pending key explicitly.
    const keyReceipts: Array<{ key: string; sha256: string }> = [];
    for (const source of profile.keySources) {
      let content: string;
      try { content = await this.store.read(source.ref, 256 * 1024); }
      catch { throw new Error(`KEY_PREFLIGHT_SOURCE_UNAVAILABLE:${source.key}`); }
      const actual = sha256(content);
      if (actual !== source.sha256) throw new Error(`KEY_PREFLIGHT_CHANGED_REQUIRES_CHATGPT:${source.key}`);
      keyReceipts.push({ key: source.key, sha256: actual });
    }
    const commands = { ...cli.commands };
    for (const [name, execution] of Object.entries(profile.commands)) {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error('PROFILE_COMMAND_NOT_CANONICAL');
      commands[name] = { ...commands[name], execution };
    }
    return { cli: { ...cli, commands }, hash: sha256(text), keyReceipts };
  }
}
