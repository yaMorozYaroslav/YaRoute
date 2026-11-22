import { inspectIniReadiness } from './init-readiness';

/**
 * Public-tenant, read-only INI preflight. This is deliberately NOT the private
 * NyxCommandExecutor bootstrap: public tenants do not own operator MAIN,
 * canonical FIF storage or the operator's global Rclone credentials.
 *
 * Resolve the canonical Head and requested sources separately through the
 * caller's authorized connector. This planner makes no claims about source
 * authenticity, readiness, visible rendering or persistent session artifacts.
 */
export interface PublicIniPlanInput {
  target?: string;
  targets?: string[];
  scope?: 'local' | 'global';
  depth?: 'basic' | 'normal' | 'deep';
}

const TOKEN = /^(?:(?:core_skill|domain|area):)?[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LOCAL_MODIFIER = /^o([lg])([bnd])$/i;
const INHERITED_MODIFIER = /^([lg])([bnd])o$/i;
const DEPTH: Record<string, 'basic' | 'normal' | 'deep'> = {
  b: 'basic', n: 'normal', d: 'deep',
};

/** Lexical parsing only: Head, not this module, owns command semantics. */
export function preparePublicIniPlan(input: PublicIniPlanInput) {
  if (!input || typeof input !== 'object' ||
      (input.target !== undefined && input.targets !== undefined)) {
    throw Error('INI_PLAN_ARGUMENTS_INVALID');
  }
  const tokens = input.targets ?? (input.target?.trim().split(/\s+/).filter(Boolean) ?? []);
  if (!Array.isArray(tokens) || tokens.length > 16 ||
      tokens.some(x => typeof x !== 'string' || x.length < 1 || x.length > 80)) {
    throw Error('INI_PLAN_TARGETS_INVALID');
  }
  const targets: string[] = [];
  const unresolvedTokens: string[] = [];
  let modifier: { scope: 'local' | 'global'; depth: 'basic' | 'normal' | 'deep' } | undefined;
  for (const token of tokens) {
    const match = LOCAL_MODIFIER.exec(token) ?? INHERITED_MODIFIER.exec(token);
    if (match) {
      if (modifier) throw Error('MODIFIER_CONFLICT');
      modifier = {
        scope: match[1].toLowerCase() === 'g' ? 'global' : 'local',
        depth: DEPTH[match[2].toLowerCase()],
      };
      continue;
    }
    if (!TOKEN.test(token)) throw Error('INI_PLAN_TARGET_INVALID');
    // A single-letter voice/chat suffix such as trailing 'I' must not become
    // an invented Area target. Preserve it for authoritative Head resolution.
    if (token.length === 1) { unresolvedTokens.push(token); continue; }
    if (!targets.some(x => x.toLowerCase() === token.toLowerCase())) targets.push(token);
  }
  if (!targets.length) throw Error('INI_PLAN_TARGET_REQUIRED');
  if (input.scope && !['local','global'].includes(input.scope)) throw Error('INI_PLAN_SCOPE_INVALID');
  if (input.depth && !['basic','normal','deep'].includes(input.depth)) throw Error('INI_PLAN_DEPTH_INVALID');
  if (input.scope && modifier && input.scope !== modifier.scope) throw Error('MODIFIER_SCOPE_CONFLICT');
  if (input.depth && modifier && input.depth !== modifier.depth) throw Error('MODIFIER_DEPTH_CONFLICT');
  const scope = input.scope ?? modifier?.scope ?? 'local';
  const depth = input.depth ?? modifier?.depth ?? 'normal';
  const normalized = `o${scope === 'global' ? 'G' : 'L'}${depth === 'basic' ? 'B' : depth === 'deep' ? 'D' : 'N'}`;
  const readiness = inspectIniReadiness();
  return {
    schema: 'nyx.public-ini-preflight.v1',
    status: readiness.status,
    execution: 'READ_ONLY_EXTERNAL_SOURCE_PLAN' as const,
    command: 'ini',
    targets,
    unresolvedTokens,
    scope, depth, modifier: normalized,
    missingGates: readiness.missingGates,
    modifierSource: modifier ? 'explicit' : input.scope || input.depth ? 'request' : 'default',
    sourceManifest: [
      {key:'canonical_head_body_footer', required:true, owner:'authorized-external-connector'},
      {key:'canonical_nyxcli_and_live_overlays', required:true, owner:'authorized-external-connector'},
      {key:'paths_registry_and_topology', required:true, owner:'authorized-external-connector'},
      {key:'typed_target_paths_config_and_status', required:true, owner:'authorized-external-connector'},
      {key:'mandatory_visible_render_receipts', required:true, owner:'conversation-renderer'},
    ],
    warnings: [
      'Targets are lexical candidates, not verified Area or Core Skill resolutions.',
      'Global routing scope does not authorize private or other-user resources.',
      'No authoritative source, target status, or canonical lineage was read by this Dev tool.',
      ...(unresolvedTokens.length ? ['Single-letter tokens require Head resolution and were not added as targets.'] : []),
    ],
    nextAction: 'Resolve the exact sources through this OAuth user’s separately authorized provider; apply current canonical Head semantics; report explicit missing gates and visible-render receipts.',
    canonicalReadVerified: false,
    fif: null,
    files_to_paste: [],
    canonicalChanged: false,
    privateBootstrapUsed: false,
    tenantSourceAccess: 'separate-authorization-required',
  };
}
