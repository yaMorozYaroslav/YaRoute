/** Provider-neutral multi-tenant connection metadata. No credentials are stored here. */
export type ConnectorProvider = 'github' | 'google-drive' | 'gitlab';
export const CONNECTOR_CAPABILITIES = ['resources:read', 'contents:write', 'ci:read', 'ci:dispatch'] as const;
export type ConnectorCapability = typeof CONNECTOR_CAPABILITIES[number];

/** The user chooses a label and enabled permissions; provider grants are verified separately. */
export interface ConnectorConnection {
  id: string; // Stable internal identity: never use the user-visible name as a credential key.
  ownerId: string;
  displayName: string; // User-defined; unique per owner (case-insensitive).
  provider: ConnectorProvider;
  externalAccountId: string;
  capabilities: ConnectorCapability[]; // User-enabled permissions (not OAuth scopes).
  providerCapabilities: ConnectorCapability[]; // Verified external grants; never client-editable.
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
    if (!validCapabilities(capabilities)) throw new Error('CONNECTOR_PERMISSIONS_INVALID');
    const selected = [...new Set(capabilities)];
    const updated = { ...connection, capabilities: selected };
    await this.repository.save(updated);
    return {
      connection: updated,
      authorizationRequired: selected.filter(cap => !updated.providerCapabilities.includes(cap)),
    };
  }

  async require(ownerId: string, connectionId: string, capability: ConnectorCapability): Promise<ConnectorConnection> {
    const connection = await this.owned(ownerId, connectionId);
    if (connection.status !== 'active') throw new Error('CONNECTOR_INACTIVE');
    if (!connection.capabilities.includes(capability)) throw new Error('CONNECTOR_FORBIDDEN');
    if (!connection.providerCapabilities.includes(capability)) throw new Error('CONNECTOR_PROVIDER_PERMISSION_REQUIRED');
    return connection;
  }
}
