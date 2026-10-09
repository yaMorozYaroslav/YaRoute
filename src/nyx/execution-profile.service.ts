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
      try { return this.applyText(await readFile(deployedPath, 'utf8'), cli, cliHash); }
      catch { throw new Error('EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE'); }
    }
    if (!locator.executionProfile) return { cli };
    try { return this.applyText(await this.store.read(locator.executionProfile, 128 * 1024), cli, cliHash); }
    catch { throw new Error('EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE'); }
  }
  private applyText(text: string, cli: Cli, cliHash: string) {
    // Operational execution bindings are explicit runtime configuration, not new canonical command definitions.
    // The canonical CLI is checked first; profile bindings cannot add commands or aliases.
    const profile = profileSchema.parse(parseJson(text));
    if (profile.cliSha256 !== cliHash) throw new Error('PROFILE_AUTHORITY_CHANGED');
    const commands = { ...cli.commands };
    for (const [name, execution] of Object.entries(profile.commands)) {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error('PROFILE_COMMAND_NOT_CANONICAL');
      commands[name] = { ...commands[name], execution };
    }
    return { cli: { ...cli, commands }, hash: sha256(text) };
  }
}
