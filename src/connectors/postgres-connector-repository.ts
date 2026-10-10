import { Pool } from 'pg';
import type { ConnectorConnection, ConnectorRepository, ConnectorProvider, ConnectorCapability } from './connector-registry';

/** Persistent metadata only: installation tokens and OAuth secrets are NEVER stored here. */
export class PostgresConnectorRepository implements ConnectorRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_connections (
      id text PRIMARY KEY,
      owner_id text NOT NULL,
      provider text NOT NULL,
      external_account_id text NOT NULL,
      installation_id text,
      capabilities jsonb NOT NULL,
      status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT nyx_connector_owner CHECK (length(owner_id) > 0),
      CONSTRAINT nyx_connector_status CHECK (status IN ('pending','active','revoked'))
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS nyx_connector_owner_idx ON nyx_connector_connections(owner_id)');
  }
  private parse(row: Record<string, unknown>): ConnectorConnection {
    return {
      id: String(row.id), ownerId: String(row.owner_id),
      provider: String(row.provider) as ConnectorProvider,
      externalAccountId: String(row.external_account_id),
      installationId: row.installation_id == null ? undefined : String(row.installation_id),
      capabilities: row.capabilities as ConnectorCapability[],
      status: row.status as ConnectorConnection['status'],
    };
  }
  async get(id: string): Promise<ConnectorConnection | null> {
    const result = await this.pool.query('SELECT * FROM nyx_connector_connections WHERE id = $1', [id]);
    return result.rows[0] ? this.parse(result.rows[0]) : null;
  }
  async list(ownerId: string): Promise<ConnectorConnection[]> {
    const result = await this.pool.query('SELECT * FROM nyx_connector_connections WHERE owner_id = $1 ORDER BY id', [ownerId]);
    return result.rows.map(row => this.parse(row));
  }
  async save(connection: ConnectorConnection): Promise<void> {
    if (!connection.id || !connection.ownerId || !connection.externalAccountId ||
      !['github','google-drive','gitlab'].includes(connection.provider) ||
      !['pending','active','revoked'].includes(connection.status) ||
      !Array.isArray(connection.capabilities) ||
      !connection.capabilities.every(x => ['resources:read','contents:write','ci:read','ci:dispatch'].includes(x))) {
      throw new Error('CONNECTOR_INVALID');
    }
    const result = await this.pool.query(`INSERT INTO nyx_connector_connections
      (id,owner_id,provider,external_account_id,installation_id,capabilities,status)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT (id) DO UPDATE SET
        provider=EXCLUDED.provider,external_account_id=EXCLUDED.external_account_id,
        installation_id=EXCLUDED.installation_id,capabilities=EXCLUDED.capabilities,
        status=EXCLUDED.status,updated_at=now()
      WHERE nyx_connector_connections.owner_id=EXCLUDED.owner_id
      RETURNING id`,
      [connection.id,connection.ownerId,connection.provider,connection.externalAccountId,
        connection.installationId ?? null,JSON.stringify(connection.capabilities),connection.status]);
    if (!result.rowCount) throw new Error('CONNECTOR_OWNER_CONFLICT');
  }
}
