import { Injectable } from '@nestjs/common';
import { LoadedSource, Locator, ResourceRef, parseJson, refSchema, routingSchema } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
import { NyxCommandResolver } from './command-resolver';
type Plan = ReturnType<NyxCommandResolver['resolve']>;
@Injectable()
export class NyxResourceResolver {
  constructor(private readonly store: NyxResourceStore) {}
  async load(locator: Locator, plan: Plan) {
    const pathsRef = locator.paths[plan.depth];
    if (!pathsRef) throw new Error('PATHS_DEPTH_ROUTE_MISSING');
    const paths = await this.store.read(pathsRef);
    const resources = plan.depth === 'basic' ? this.markdownRoutes(paths) : routingSchema.parse(parseJson(paths)).resources;
    const files: LoadedSource[] = [{ key: 'paths', ref: pathsRef, content: paths, sha256: sha256(paths), bytes: Buffer.byteLength(paths), visible: plan.contract.pathsVisible }];
    const warnings: string[] = [];
    const loaded = new Map<string, LoadedSource>();
    for (const source of plan.contract.sources[plan.depth]) {
      if (source.when === 'targeted' && !plan.targets.length) continue;
      const keys = source.perTarget ? plan.targets.map(t => source.key.replaceAll('{target}', t)) : [source.key];
      for (const key of keys) {
        let ref: ResourceRef | undefined;
        try {
          ref = this.route(resources, key);
          if (!ref) throw new Error('SOURCE_ROUTE_MISSING');
          const identity = JSON.stringify(ref);
          const prior = loaded.get(identity);
          if (prior) { prior.visible ||= source.visible; continue; }
          const content = await this.store.read(ref);
          const file = { key, ref, content, sha256: sha256(content), bytes: Buffer.byteLength(content), visible: source.visible };
          loaded.set(identity, file); files.push(file);
        } catch {
          if (source.required) throw new Error(`REQUIRED_SOURCE_UNAVAILABLE:${key}`);
          warnings.push(`OPTIONAL_SOURCE_UNAVAILABLE:${key}`);
        }
      }
    }
    const handoffs = plan.contract.handoffsKey ? this.route(resources, plan.contract.handoffsKey) : undefined;
    if (plan.contract.mutation === 'conversation-artifact' && !handoffs) throw new Error('HANDOFFS_ROUTE_MISSING');
    return { files, warnings, handoffs };
  }
  private route(resources: Record<string, ResourceRef>, key: string) {
    const matches = Object.keys(resources).filter(k => k.toLowerCase() === key.toLowerCase());
    if (matches.length > 1) throw new Error('AMBIGUOUS_RESOURCE_ROUTE');
    return matches.length ? resources[matches[0]] : undefined;
  }
  markdownRoutes(text: string): Record<string, ResourceRef> {
    // Human-readable Basic Markdown table; no Basic JSON registry is introduced.
    const resources: Record<string, ResourceRef> = Object.create(null);
    let active = false;
    for (const line of text.split(/\r?\n/)) {
      const cells = line.trim().split('|').slice(1, -1).map(x => x.trim().replace(/^`|`$/g, ''));
      if (cells.join('|').toLowerCase() === 'key|area|path') { active = true; continue; }
      if (!active) continue;
      if (!line.trim().startsWith('|')) { active = false; continue; }
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      if (cells.length !== 3 || !/^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/.test(cells[0])) throw new Error('BASIC_PATHS_ROUTE_INVALID');
      if (Object.keys(resources).some(k => k.toLowerCase() === cells[0].toLowerCase())) throw new Error('DUPLICATE_RESOURCE_ROUTE');
      resources[cells[0]] = refSchema.parse({ area: cells[1], path: cells[2] });
    }
    return resources;
  }
}
