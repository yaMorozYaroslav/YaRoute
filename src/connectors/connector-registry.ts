/** Provider-neutral multi-tenant connection metadata. No credentials are stored here. */
import { assertNoFinancialAccess, isFinanciallyProhibited } from './financial-safety';
export type ConnectorProvider = 'github' | 'google-drive' | 'gitlab' | 'mega' | 'heroku';
export const CONNECTOR_CAPABILITIES = ['resources:read', 'contents:write', 'ci:read', 'ci:dispatch',
  'storage:list', 'storage:stat', 'storage:read', 'storage:capacity', 'storage:index',
  'storage:write', 'storage:copy', 'storage:move', 'storage:delete',
  'git:inspect', 'git:clone', 'git:fetch', 'git:diff', 'git:branch',
  'git:commit', 'git:push', 'git:tag',
  'git:checkout', 'git:merge', 'git:rebase', 'git:cherry-pick', 'git:revert',
  'git:stash', 'git:reset', 'git:clean', 'git:worktree',
  'repository:metadata', 'pulls:read', 'pulls:write', 'issues:read', 'issues:write',
  'releases:read', 'releases:write',
  'heroku:apps:read', 'heroku:config:names', 'heroku:releases:read', 'heroku:logs:read',
  'heroku:config:write', 'heroku:deploy', 'heroku:apps:create', 'heroku:apps:restart'] as const;
export type ConnectorCapability = typeof CONNECTOR_CAPABILITIES[number];
/** UI MUST NOT offer old/forbidden payment, provisioning or unrestricted config capabilities. */
export const SELECTABLE_CONNECTOR_CAPABILITIES = CONNECTOR_CAPABILITIES.filter(
  capability => !isFinanciallyProhibited(capability),
);

/** The user chooses a label and enabled permissions; provider grants are verified separately. */
export type ConnectorResourceKind = 'repository' | 'drive' | 'folder' | 'mega-root' | 'heroku-app' | 'heroku-account';
/** Explicit user-selected resource boundary. Provider grants are checked separately. */
export interface ConnectorResourceRule {
  kind: ConnectorResourceKind;
  id: string;
  capabilities: ConnectorCapability[];
  pathPrefix?: string;
  branches?: string[];
}
export interface ConnectorConnection {
  id: string; // Stable internal identity: never use the user-visible name as a credential key.
  ownerId: string;
  displayName: string; // User-defined; unique per owner (case-insensitive).
  provider: ConnectorProvider;
  externalAccountId: string;
  capabilities: ConnectorCapability[]; // User-enabled permissions (not OAuth scopes).
  providerCapabilities: ConnectorCapability[]; // Verified external grants; never client-editable.
  resources?: ConnectorResourceRule[]; // No selected resources means deny resource operations.
  status: 'pending' | 'active' | 'revoked';
  installationId?: string;
}
export interface ConnectorRepository {
  get(id: string): Promise<ConnectorConnection | null>;
  list(ownerId: string): Promise<ConnectorConnection[]>;
  save(connection: ConnectorConnection): Promise<void>;
}

function validCapabilities(values: readonly ConnectorCapability[]): boolean {
  return Array.isArray(values) &&
    values.every(value => (CONNECTOR_CAPABILITIES as readonly string[]).includes(value));
}
const gitProviders = new Set<ConnectorProvider>(['github','gitlab']);
export function supportsCapability(provider: ConnectorProvider, capability: ConnectorCapability): boolean {
  if (isFinanciallyProhibited(capability)) return false;
  if (/^(git:|repository:|pulls:|issues:|releases:|ci:)/.test(capability)) return gitProviders.has(provider);
  if (capability.startsWith('heroku:')) return provider === 'heroku';
  if (capability.startsWith('storage:')) return provider === 'google-drive' || provider === 'mega';
  return true;
}
export function validateResourceRules(provider: ConnectorProvider, rules: ConnectorResourceRule[]): ConnectorResourceRule[] {
  if (!Array.isArray(rules) || rules.length > 500) throw new Error('CONNECTOR_RESOURCES_INVALID');
  return rules.map(rule => {
    if (!rule || !['repository','drive','folder','mega-root','heroku-app','heroku-account'].includes(rule.kind) ||
      typeof rule.id !== 'string' || !rule.id || rule.id.length > 512 ||
      !Array.isArray(rule.capabilities) || !rule.capabilities.every(c => (CONNECTOR_CAPABILITIES as readonly string[]).includes(c) && supportsCapability(provider,c))) {
      throw new Error('CONNECTOR_RESOURCES_INVALID');
    }
    if (gitProviders.has(provider) !== (rule.kind === 'repository') ||
      (provider === 'google-drive' && !['drive','folder'].includes(rule.kind)) ||
      (provider === 'mega' && rule.kind !== 'mega-root') ||
      (provider === 'heroku' && !['heroku-app','heroku-account'].includes(rule.kind))) throw new Error('CONNECTOR_RESOURCE_PROVIDER_MISMATCH');
    if (rule.kind === 'repository' && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rule.id) || rule.id.includes('..'))) throw new Error('CONNECTOR_REPOSITORY_INVALID');
    if (rule.pathPrefix !== undefined && (!rule.pathPrefix || rule.pathPrefix.startsWith('/') ||
      rule.pathPrefix.includes('\\') || rule.pathPrefix.length > 2048 ||
      rule.pathPrefix.split('/').some(p => !p || p === '.' || p === '..'))) throw new Error('CONNECTOR_PATH_INVALID');
    if (rule.branches !== undefined && (rule.kind !== 'repository' || !Array.isArray(rule.branches) ||
      !rule.branches.length || rule.branches.length > 50 ||
      rule.branches.some(b => !/^[A-Za-z0-9_.\/-]{1,120}$/.test(b) || b.includes('..') || b.startsWith('-')))) throw new Error('CONNECTOR_BRANCHES_INVALID');
    return {...rule,capabilities:[...new Set(rule.capabilities)]};
  });
}
/** Old fixed slots may be offered as editable suggestions, never enforced. */
export const LEGACY_NAME_HINTS: Partial<Record<ConnectorProvider,readonly string[]>> = {
  'google-drive':['google_main','google_work','google_a','google_b','google_c','google_d'],
  mega:['mega_main','mega_work'],
};
export function suggestConnectionName(provider: ConnectorProvider, existingNames: string[]): string {
  const used = new Set(existingNames.map(n => n.trim().toLowerCase()));
  for (const hint of LEGACY_NAME_HINTS[provider] ?? []) if (!used.has(hint.toLowerCase())) return hint;
  const base = {github:'GitHub',gitlab:'GitLab',mega:'MEGA',heroku:'Heroku','google-drive':'Google Drive'}[provider];
  let name = base, n = 1;
  while (used.has(name.toLowerCase())) name = base + ' ' + ++n;
  return name;
}
export function validateConnectionName(value: string): string {
  if (typeof value !== 'string') throw new Error('CONNECTOR_NAME_INVALID');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('CONNECTOR_NAME_INVALID');
  }
  return trimmed;
}

export class ConnectorRegistry {
  constructor(private readonly repository: ConnectorRepository) {}

  async list(ownerId: string): Promise<ConnectorConnection[]> {
    if (!ownerId) throw new Error('CONNECTOR_OWNER_REQUIRED');
    return (await this.repository.list(ownerId)).filter(connection => connection.ownerId === ownerId);
  }

  private async owned(ownerId: string, connectionId: string): Promise<ConnectorConnection> {
    if (!ownerId || !connectionId) throw new Error('CONNECTOR_IDENTITY_REQUIRED');
    const connection = await this.repository.get(connectionId);
    if (!connection || connection.ownerId !== ownerId) throw new Error('CONNECTOR_NOT_FOUND');
    return connection;
  }

  /** Change the display label without moving credentials, changing OAuth grants, or changing ID. */
  async rename(ownerId: string, connectionId: string, name: string): Promise<ConnectorConnection> {
    const connection = await this.owned(ownerId, connectionId);
    const updated = { ...connection, displayName: validateConnectionName(name) };
    await this.repository.save(updated);
    return updated;
  }

  /**
   * Save user-selected effective permissions. Enabling an operation cannot grant provider
   * scopes: require() still checks the independently verified providerCapabilities.
   * Caller identity must come from authenticated NestNyx context, never request input.
   */
  async setPermissions(ownerId: string, connectionId: string, capabilities: ConnectorCapability[]): Promise<{
    connection: ConnectorConnection;
    authorizationRequired: ConnectorCapability[];
  }> {
    const connection = await this.owned(ownerId, connectionId);
    capabilities.forEach(assertNoFinancialAccess);
    if (!validCapabilities(capabilities) || capabilities.some(c => !supportsCapability(connection.provider,c))) throw new Error('CONNECTOR_PERMISSIONS_INVALID');
    const selected = [...new Set(capabilities)];
    const updated = { ...connection, capabilities: selected };
    await this.repository.save(updated);
    return {
      connection: updated,
      authorizationRequired: selected.filter(cap => !updated.providerCapabilities.includes(cap)),
    };
  }

  async setResources(ownerId: string, connectionId: string, resources: ConnectorResourceRule[]): Promise<ConnectorConnection> {
    const connection = await this.owned(ownerId, connectionId);
    const updated = {...connection,resources:validateResourceRules(connection.provider,resources)};
    await this.repository.save(updated);
    return updated;
  }
  async require(ownerId: string, connectionId: string, capability: ConnectorCapability): Promise<ConnectorConnection> {
    assertNoFinancialAccess(capability);
    const connection = await this.owned(ownerId, connectionId);
    if (connection.status !== 'active') throw new Error('CONNECTOR_INACTIVE');
    if (!supportsCapability(connection.provider,capability) || !connection.capabilities.includes(capability)) throw new Error('CONNECTOR_FORBIDDEN');
    if (!connection.providerCapabilities.includes(capability)) throw new Error('CONNECTOR_PROVIDER_PERMISSION_REQUIRED');
    return connection;
  }
  async requireResource(ownerId: string, connectionId: string, capability: ConnectorCapability,
    resource: {kind: ConnectorResourceKind; id: string; path?: string; branch?: string}): Promise<ConnectorConnection> {
    const connection = await this.require(ownerId,connectionId,capability);
    if (resource.path !== undefined && (resource.path.startsWith('/') || resource.path.includes('\\') ||
      resource.path.split('/').some(p => p === '.' || p === '..'))) throw new Error('CONNECTOR_PATH_INVALID');
    if (!(connection.resources ?? []).some(rule =>
      rule.kind === resource.kind && rule.id.toLowerCase() === resource.id.toLowerCase() &&
      rule.capabilities.includes(capability) &&
      (!rule.pathPrefix || (resource.path !== undefined &&
        (resource.path === rule.pathPrefix || resource.path.startsWith(rule.pathPrefix + '/')))) &&
      (!rule.branches?.length || (resource.branch !== undefined && rule.branches.includes(resource.branch))))) {
      throw new Error('CONNECTOR_RESOURCE_FORBIDDEN');
    }
    return connection;
  }
}
