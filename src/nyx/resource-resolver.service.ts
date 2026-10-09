import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { LoadedSource, Locator, ResourceRef, parseJson, refSchema, routingSchema } from './runtime.schema';
import { NyxResourceStore, sha256 } from './resource-store.service';
import { NyxCommandResolver } from './command-resolver';
type Plan = ReturnType<NyxCommandResolver['resolve']>;

@Injectable()
export class NyxResourceResolver {
  constructor(private readonly store: NyxResourceStore) {}
  async load(locator: Locator, plan: Plan) {
    if (!plan.contract.scope) return this.loadLegacy(locator, plan);

    // Scoped chat initialization always exposes the compact human paths.md. Normal/Deep registries
    // are verification/routing context and stay hidden unless a later command explicitly returns them.
    const pathsRef = locator.paths.basic;
    const paths = await this.store.read(pathsRef);
    const resources = this.markdownRoutes(paths);
    const files: LoadedSource[] = [{ key: 'paths', ref: pathsRef, content: paths, sha256: sha256(paths), bytes: Buffer.byteLength(paths), visible: plan.contract.pathsVisible }];
    const warnings: string[] = [];
    if (plan.depth !== 'basic') {
      const depthRef = locator.paths[plan.depth];
      if (!depthRef) throw new Error(`DEPTH_REGISTRY_UNAVAILABLE:${plan.depth}`);
      try {
        const content = await this.store.read(depthRef);
        this.validateDepthRegistry(content, plan.depth);
        files.push({ key: `${plan.depth}_paths`, ref: depthRef, content, sha256: sha256(content), bytes: Buffer.byteLength(content), visible: false });
      } catch { throw new Error(`DEPTH_REGISTRY_UNAVAILABLE:${plan.depth}`); }
    }

    const pending: Array<{ key: string; ref: ResourceRef; required: boolean; visible: boolean }> = [];
    const identities = new Map<string, typeof pending[number]>();
    for (const source of plan.contract.sources[plan.depth]) {
      if (source.when === 'targeted' && !plan.targets.length) continue;
      const keys = source.perTarget ? plan.targets.map(t => source.key.replaceAll('{target}', t)) : [source.key];
      for (const key of keys) {
        const ref = key.toLowerCase() === 'nyxcli' ? locator.humanCli : this.route(resources, key);
        if (!ref) {
          if (source.required) throw new Error(`REQUIRED_SOURCE_UNAVAILABLE:${key}`);
          warnings.push(`OPTIONAL_SOURCE_UNAVAILABLE:${key}`); continue;
        }
        this.assertScope(plan, ref, key);
        const identity = JSON.stringify(ref);
        const prior = identities.get(identity);
        if (prior) { prior.visible ||= source.visible; prior.required ||= source.required; continue; }
        const item = { key, ref, required: source.required, visible: source.visible };
        identities.set(identity, item); pending.push(item);
      }
    }
    await this.readPending(pending, files, warnings);
    await this.hydrateTargetOwners(plan, resources, files, warnings);
    const handoffs = plan.contract.handoffsKey ? this.route(resources, plan.contract.handoffsKey) : undefined;
    if (plan.contract.mutation === 'conversation-artifact' && !handoffs) throw new Error('HANDOFFS_ROUTE_MISSING');
    if (handoffs) this.assertScope(plan, handoffs, plan.contract.handoffsKey!);
    return { files, warnings, handoffs };
  }

  async resolveHandoffs(locator: Locator, plan: Plan) {
    if (!plan.contract.handoffsKey) throw new Error('HANDOFFS_ROUTE_MISSING');
    const paths = await this.store.read(locator.paths.basic);
    const ref = this.route(this.markdownRoutes(paths), plan.contract.handoffsKey);
    if (!ref) throw new Error('HANDOFFS_ROUTE_MISSING');
    this.assertScope(plan, ref, plan.contract.handoffsKey);
    return ref;
  }

  private async loadLegacy(locator: Locator, plan: Plan) {
    const pathsRef = locator.paths[plan.depth];
    if (!pathsRef) throw new Error('PATHS_DEPTH_ROUTE_MISSING');
    const paths = await this.store.read(pathsRef);
    const resources = plan.depth === 'basic' ? this.markdownRoutes(paths) : routingSchema.parse(parseJson(paths)).resources;
    const files: LoadedSource[] = [{ key: 'paths', ref: pathsRef, content: paths, sha256: sha256(paths), bytes: Buffer.byteLength(paths), visible: plan.contract.pathsVisible }];
    const warnings: string[] = [];
    const pending: Array<{ key: string; ref: ResourceRef; required: boolean; visible: boolean }> = [];
    const identities = new Map<string, typeof pending[number]>();
    for (const source of plan.contract.sources[plan.depth]) {
      if (source.when === 'targeted' && !plan.targets.length) continue;
      const keys = source.perTarget ? plan.targets.map(t => source.key.replaceAll('{target}', t)) : [source.key];
      for (const key of keys) {
        const ref = this.route(resources, key);
        if (!ref) {
          if (source.required) throw new Error(`REQUIRED_SOURCE_UNAVAILABLE:${key}`);
          warnings.push(`OPTIONAL_SOURCE_UNAVAILABLE:${key}`); continue;
        }
        const identity = JSON.stringify(ref);
        const prior = identities.get(identity);
        if (prior) { prior.visible ||= source.visible; prior.required ||= source.required; continue; }
        const item = { key, ref, required: source.required, visible: source.visible };
        identities.set(identity, item); pending.push(item);
      }
    }
    await this.readPending(pending, files, warnings);
    const handoffs = plan.contract.handoffsKey ? this.route(resources, plan.contract.handoffsKey) : undefined;
    if (plan.contract.mutation === 'conversation-artifact' && !handoffs) throw new Error('HANDOFFS_ROUTE_MISSING');
    return { files, warnings, handoffs };
  }

  private async hydrateTargetOwners(plan: Plan, resources: Record<string, ResourceRef>, files: LoadedSource[], warnings: string[]) {
    if (!plan.contract.scope || !plan.targets.length) return;
    const seen = new Set(files.map(file => JSON.stringify(file.ref)));
    for (const target of plan.targets) {
      const manifestRef = this.route(resources, `${target}.area_paths`);
      if (!manifestRef) continue;
      this.assertScope(plan, manifestRef, `${target}.area_paths`);
      let manifestText: string;
      try { manifestText = await this.store.read(manifestRef); }
      catch { throw new Error(`REQUIRED_SOURCE_UNAVAILABLE:${target}.area_paths`); }
      const manifestFile: LoadedSource = {
        key: `${target}.area_paths`, ref: manifestRef, content: manifestText,
        sha256: sha256(manifestText), bytes: Buffer.byteLength(manifestText), visible: false,
      };
      if (!seen.has(JSON.stringify(manifestRef))) {
        files.push(manifestFile); seen.add(JSON.stringify(manifestRef));
      }
      let manifest: any;
      try { manifest = parseJson(manifestText); }
      catch { throw new Error(`AREA_MANIFEST_INVALID:${target}`); }
      const candidates = [
        ['config', manifest?.config?.file ?? manifest?.configs?.file],
        ['state', manifest?.central_mutable_state?.file ?? manifest?.main_state?.file],
      ].filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].length > 0);
      const base = path.posix.dirname(manifestRef.path);
      for (const [role, relative] of candidates) {
        const ref = { ...manifestRef, path: path.posix.join(base, relative) };
        this.assertScope(plan, ref, `${target}.${role}`);
        const identity = JSON.stringify(ref);
        if (seen.has(identity)) continue;
        try {
          const content = await this.store.read(ref);
          files.push({ key: `${target}.${role}`, ref, content, sha256: sha256(content), bytes: Buffer.byteLength(content), visible: false });
          seen.add(identity);
        } catch {
          warnings.push(`OPTIONAL_SOURCE_UNAVAILABLE:${target}.${role}`);
        }
      }
    }
  }

  private async readPending(pending: Array<{ key: string; ref: ResourceRef; required: boolean; visible: boolean }>, files: LoadedSource[], warnings: string[]) {
    const results: Array<LoadedSource | undefined> = new Array(pending.length);
    const failures: Array<string | undefined> = new Array(pending.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const index = next++, source = pending[index];
        try {
          const content = await this.store.read(source.ref);
          results[index] = { key: source.key, ref: source.ref, content, sha256: sha256(content), bytes: Buffer.byteLength(content), visible: source.visible };
        } catch { failures[index] = `${source.required ? 'REQUIRED' : 'OPTIONAL'}_SOURCE_UNAVAILABLE:${source.key}`; }
      }
    }));
    for (let i = 0; i < pending.length; i++) {
      if (failures[i]) {
        if (pending[i].required) throw new Error(failures[i]);
        warnings.push(failures[i]!);
      } else files.push(results[i]!);
    }
  }

  private assertScope(plan: Plan, ref: ResourceRef, key: string) {
    if (plan.scope !== 'local' || !plan.contract.scope) return;
    if (!plan.contract.scope.localAreas.some(area => area.toLowerCase() === ref.area.toLowerCase())) throw new Error(`LOCAL_SCOPE_RESOURCE_FORBIDDEN:${key}`);
  }
  private validateDepthRegistry(text: string, depth: 'normal' | 'deep') {
    const parsed = parseJson(text) as any;
    if (!parsed || typeof parsed !== 'object') throw new Error('DEPTH_REGISTRY_INVALID');
    if (parsed.schema === 'nyx.paths.v1') { routingSchema.parse(parsed); return; }
    const accepted = depth === 'normal' ? ['normal', 'oN'] : ['deep', 'oD'];
    if (typeof parsed.depth !== 'string' || !accepted.includes(parsed.depth)) throw new Error('DEPTH_REGISTRY_INVALID');
  }
  private route(resources: Record<string, ResourceRef>, key: string) {
    const matches = Object.keys(resources).filter(k => k.toLowerCase() === key.toLowerCase());
    if (matches.length > 1) throw new Error('AMBIGUOUS_RESOURCE_ROUTE');
    return matches.length ? resources[matches[0]] : undefined;
  }
  markdownRoutes(text: string): Record<string, ResourceRef> {
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
