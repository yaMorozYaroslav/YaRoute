import { Pool } from 'pg';
import {
  CONNECTOR_CAPABILITIES,
  validateConnectionName,
  validateResourceRules,
} from './connector-registry';
import type { ConnectorConnection, ConnectorRepository, ConnectorProvider, ConnectorCapability } from './connector-registry';

/** Persistent, tenant-scoped metadata. Credentials and installation tokens do not belong here. */
export class PostgresConnectorRepository implements ConnectorRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_connections (
      id text PRIMARY KEY,
      owner_id text NOT NULL,
      display_name text NOT NULL,
      provider text NOT NULL,
      external_account_id text NOT NULL,
      installation_id text,
      capabilities jsonb NOT NULL,
      provider_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      resources jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT nyx_connector_owner CHECK (length(owner_id) > 0),
      CONSTRAINT nyx_connector_status CHECK (status IN ('pending','active','revoked'))
    )`);
    // Non-destructive evolution of the early connector metadata table. Legacy names use
    // immutable IDs temporarily, so the user can rename them later without changing IDs.
    await this.pool.query('ALTER TABLE nyx_connector_connections ADD COLUMN IF NOT EXISTS display_name text');
    await this.pool.query("ALTER TABLE nyx_connector_connections ADD COLUMN IF NOT EXISTS provider_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb");
    await this.pool.query("ALTER TABLE nyx_connector_connections ADD COLUMN IF NOT EXISTS resources jsonb NOT NULL DEFAULT '[]'::jsonb");
    await this.pool.query('UPDATE nyx_connector_connections SET display_name = id WHERE display_name IS NULL');
    await this.pool.query('ALTER TABLE nyx_connector_connections ALTER COLUMN display_name SET NOT NULL');
    await this.pool.query('CREATE INDEX IF NOT EXISTS nyx_connector_owner_idx ON nyx_connector_connections(owner_id)');
    await this.pool.query('CREATE UNIQUE INDEX IF NOT EXISTS nyx_connector_owner_name_uq ON nyx_connector_connections (owner_id, lower(display_name))');
    // One active owner+remote binding, while allowing many accounts per provider.
    // Existing historical revoked rows remain untouched.
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS nyx_rclone_owner_remote_uq ON nyx_connector_connections(owner_id, provider, external_account_id) WHERE provider IN ('google-drive','mega') AND status <> 'revoked'");
  }

  private parse(row: Record<string, unknown>): ConnectorConnection {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      displayName: String(row.display_name ?? row.id),
      provider: String(row.provider) as ConnectorProvider,
      externalAccountId: String(row.external_account_id),
      installationId: row.installation_id == null ? undefined : String(row.installation_id),
      capabilities: row.capabilities as ConnectorCapability[],
      providerCapabilities: (row.provider_capabilities ?? []) as ConnectorCapability[],
      resources: (row.resources ?? []) as ConnectorConnection['resources'],
      status: row.status as ConnectorConnection['status'],
    };
  }

  async get(id: string): Promise<ConnectorConnection | null> {
    const result = await this.pool.query('SELECT * FROM nyx_connector_connections WHERE id = $1', [id]);
    return result.rows[0] ? this.parse(result.rows[0]) : null;
  }

  async list(ownerId: string): Promise<ConnectorConnection[]> {
    const result = await this.pool.query('SELECT * FROM nyx_connector_connections WHERE owner_id = $1 ORDER BY lower(display_name), id', [ownerId]);
    return result.rows.map(row => this.parse(row));
  }

  async save(connection: ConnectorConnection): Promise<void> {
    const known = CONNECTOR_CAPABILITIES as readonly string[];
    if (!connection.id || !connection.ownerId || !connection.externalAccountId ||
      !['github','google-drive','gitlab','mega','heroku'].includes(connection.provider) ||
      !['pending','active','revoked'].includes(connection.status) ||
      !Array.isArray(connection.capabilities) ||
      !connection.capabilities.every(value => known.includes(value)) ||
      !Array.isArray(connection.providerCapabilities) ||
      !connection.providerCapabilities.every(value => known.includes(value))) {
      throw new Error('CONNECTOR_INVALID');
    }
    const displayName = validateConnectionName(connection.displayName);
    const resources = validateResourceRules(connection.provider,connection.resources ?? []);
    const result = await this.pool.query(`INSERT INTO nyx_connector_connections
      (id,owner_id,display_name,provider,external_account_id,installation_id,capabilities,provider_capabilities,resources,status)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT (id) DO UPDATE SET
        display_name=EXCLUDED.display_name,
        provider=EXCLUDED.provider,external_account_id=EXCLUDED.external_account_id,
        installation_id=EXCLUDED.installation_id,capabilities=EXCLUDED.capabilities,
        provider_capabilities=EXCLUDED.provider_capabilities,
        resources=EXCLUDED.resources,
        status=EXCLUDED.status,updated_at=now()
      WHERE nyx_connector_connections.owner_id=EXCLUDED.owner_id
      RETURNING id`,
      [connection.id,connection.ownerId,displayName,connection.provider,connection.externalAccountId,
        connection.installationId ?? null,JSON.stringify(connection.capabilities),
        JSON.stringify(connection.providerCapabilities),JSON.stringify(resources),connection.status]);
    if (!result.rowCount) throw new Error('CONNECTOR_OWNER_CONFLICT');
  }
}
