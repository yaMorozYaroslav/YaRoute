import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';

@Injectable()
export class NyxCliWarmupService implements OnApplicationBootstrap {
  constructor(private readonly bootstrap: NyxBootstrapService, private readonly registry: NyxCliRegistryService) {}
  async onApplicationBootstrap() {
    if (!process.env.NYX_BOOTSTRAP_PATH) return;
    try { await this.registry.current(await this.bootstrap.locate()); }
    catch { console.warn('Nyx CLI cache warmup unavailable; commands will validate authority on demand.'); }
  }
}
