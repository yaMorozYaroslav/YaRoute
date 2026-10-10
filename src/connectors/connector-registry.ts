/** Provider-neutral multi-tenant connection metadata. No credentials are stored here. */
export type ConnectorProvider = 'github' | 'google-drive' | 'gitlab';
export type ConnectorCapability = 'resources:read' | 'contents:write' | 'ci:read' | 'ci:dispatch';
export interface ConnectorConnection {
  id: string;
  ownerId: string;
  provider: ConnectorProvider;
  externalAccountId: string;
  capabilities: ConnectorCapability[];
  status: 'pending' | 'active' | 'revoked';
  installationId?: string;
}
export interface ConnectorRepository {
  get(id: string): Promise<ConnectorConnection | null>;
  list(ownerId: string): Promise<ConnectorConnection[]>;
  save(connection: ConnectorConnection): Promise<void>;
}
export class ConnectorRegistry {
  constructor(private readonly repository: ConnectorRepository) {}
  async list(ownerId: string): Promise<ConnectorConnection[]> {
    if (!ownerId) throw new Error('CONNECTOR_OWNER_REQUIRED');
    return (await this.repository.list(ownerId)).filter(c => c.ownerId === ownerId);
  }
  async require(ownerId: string, connectionId: string, capability: ConnectorCapability): Promise<ConnectorConnection> {
    if (!ownerId || !connectionId) throw new Error('CONNECTOR_IDENTITY_REQUIRED');
    const connection = await this.repository.get(connectionId);
    if (!connection || connection.ownerId !== ownerId) throw new Error('CONNECTOR_NOT_FOUND');
    if (connection.status !== 'active') throw new Error('CONNECTOR_INACTIVE');
    if (!connection.capabilities.includes(capability)) throw new Error('CONNECTOR_FORBIDDEN');
    return connection;
  }
}
