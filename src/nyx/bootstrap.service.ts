import { Injectable } from '@nestjs/common';
import { locatorSchema, Locator, parseJson, refSchema } from './runtime.schema';
import { NyxResourceStore } from './resource-store.service';
@Injectable()
export class NyxBootstrapService {
  constructor(private readonly store: NyxResourceStore) {}
  async locate(): Promise<Locator> {
    const configured = process.env.NYX_BOOTSTRAP_PATH;
    if (!configured) throw new Error('NYX_BOOTSTRAP_PATH_NOT_CONFIGURED');
    const ref = refSchema.parse({ area: process.env.NYX_INIT_AREA || 'MAIN', path: configured });
    try { return locatorSchema.parse(parseJson(await this.store.read(ref, 64 * 1024))); }
    catch { throw new Error('BOOTSTRAP_INVALID_OR_UNAVAILABLE'); }
  }
}
