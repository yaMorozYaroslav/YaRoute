import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectorRegistry } from './connector-registry';
import { PostgresConnectorRepository } from './postgres-connector-repository';
import {
  type ConnectorConnection, type ConnectorCapability, type ConnectorProvider,
  type ConnectorResourceRule, SELECTABLE_CONNECTOR_CAPABILITIES,
  supportsCapability, validateConnectionName,
} from './connector-registry';

/**
 * The only per-owner connection metadata writer exposed to MCP.
 * Never accepts external grants, installation identity or status from caller.
 */
@Injectable()
export class ConnectorsService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private registry?: ConnectorRegistry;
  private repository?: PostgresConnectorRepository;

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
          process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') {
        throw new Error('CONNECTORS_DATABASE_REQUIRED');
      }
      return;
    }
    this.pool = new Pool({connectionString: process.env.DATABASE_URL,
      max: 5, connectionTimeoutMillis: 5000});
    this.repository = new PostgresConnectorRepository(this.pool);
    await this.repository.initialize();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_link_states (
      state_digest text PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      provider text NOT NULL,
      installation_id text,
      expires_at timestamptz NOT NULL
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS nyx_link_expiry_idx ON nyx_connector_link_states(expires_at)');
    this.registry = new ConnectorRegistry(this.repository);
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private db(): Pool {
    if (!this.pool || !this.registry) throw new Error('CONNECTORS_DATABASE_UNAVAILABLE');
    return this.pool;
  }
  private policy(): ConnectorRegistry {
    this.db();
    return this.registry!;
  }
  private owner(value: string): string {
    if (!value || !/^oauth:[^\x00-\x1f]{1,500}$/.test(value)) throw new Error('CONNECTOR_OWNER_INVALID');
    return value;
  }
  private async owned(ownerId: string, id: string): Promise<ConnectorConnection> {
    this.owner(ownerId);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('CONNECTOR_ID_INVALID');
    const result = await this.repository!.get(id);
    if (!result || result.ownerId !== ownerId) throw new Error('CONNECTOR_NOT_FOUND');
    return result;
  }
  async list(ownerId: string) {
    this.owner(ownerId);
    return (await this.policy().list(ownerId)).map(connection => this.view(connection));
  }
  view(c: ConnectorConnection) {
    const { id, displayName, provider, externalAccountId,
      capabilities, providerCapabilities, resources, status } = c;
    return {
      id, displayName, provider, externalAccountId, capabilities, providerCapabilities,
      resources: resources ?? [], status,
      availableCapabilities: SELECTABLE_CONNECTOR_CAPABILITIES.filter(x => supportsCapability(provider,x)),
    };
  }
  async create(ownerId: string, provider: ConnectorProvider, name: string) {
    this.owner(ownerId);
    if (!['github','heroku'].includes(provider)) throw new Error('CONNECTOR_PROVIDER_NOT_READY');
    const connection: ConnectorConnection = {
      id: randomUUID(), ownerId, provider,
      displayName: validateConnectionName(name), externalAccountId: 'pending',
      capabilities: [], providerCapabilities: [], resources: [], status: 'pending',
    };
    await this.policy().list(ownerId); // Verify DB before writing.
    await this.repository!.save(connection);
    return this.view(connection);
  }
  async rename(ownerId: string, id: string, name: string) {
    return this.view(await this.policy().rename(this.owner(ownerId), id, name));
  }
  async permissions(ownerId: string, id: string, capabilities: ConnectorCapability[]) {
    const result = await this.policy().setPermissions(this.owner(ownerId), id, capabilities);
    return {...this.view(result.connection), authorizationRequired: result.authorizationRequired};
  }
  async resources(ownerId: string, id: string, rules: ConnectorResourceRule[]) {
    return this.view(await this.policy().setResources(this.owner(ownerId), id, rules));
  }
  async disconnect(ownerId: string, id: string) {
    await this.owned(ownerId,id);
    await this.db().query(
      `UPDATE nyx_connector_connections SET status='revoked',
       capabilities='[]'::jsonb, provider_capabilities='[]'::jsonb,
       resources='[]'::jsonb, installation_id=NULL, updated_at=now()
       WHERE id=$1 AND owner_id=$2`,
      [id,ownerId],
    );
    await this.db().query('DELETE FROM nyx_connector_link_states WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,id]);
    return {id,status:'revoked',providerUninstallRequired:true};
  }
  async getOwned(ownerId:string, id:string) { return this.owned(this.owner(ownerId), id); }
  registryPolicy() { return this.policy(); }

  async beginGithub(ownerId:string, id:string, installationId:string) {
    const c = await this.owned(ownerId,id);
    if (c.provider !== 'github' || c.status !== 'pending') throw new Error('GITHUB_CONNECTION_NOT_PENDING');
    if (!/^[1-9][0-9]{0,19}$/.test(installationId)) throw new Error('GITHUB_INSTALLATION_INVALID');
    const clientId = process.env.NYX_GITHUB_CLIENT_ID;
    const publicUrl = process.env.NYX_PUBLIC_URL;
    if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId) ||
      !publicUrl || !/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(publicUrl.replace(/\/$/,''))) {
      throw new Error('GITHUB_OAUTH_NOT_CONFIGURED');
    }
    const state = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(state).digest('hex');
    await this.db().query('DELETE FROM nyx_connector_link_states WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,id]);
    await this.db().query(
      `INSERT INTO nyx_connector_link_states
       (state_digest,owner_id,connection_id,provider,installation_id,expires_at)
       VALUES($1,$2,$3,'github',$4,now()+interval '10 minutes')`,
      [digest,ownerId,id,installationId],
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id',clientId);
    url.searchParams.set('redirect_uri',publicUrl.replace(/\/$/,'')+'/connect/github/callback');
    url.searchParams.set('state',state);
    // GitHub App user authorization. No extra classic OAuth scopes requested.
    return {url:url.toString(),expiresInSeconds:600,
      message:'Install the NestNyx GitHub App on selected repositories first. Then authorize your GitHub identity via this link.'};
  }
  async consumeGithubState(state:string) {
    if (!state || !/^[A-Za-z0-9_-]{40,64}$/.test(state)) throw new Error('CONNECTOR_LINK_STATE_INVALID');
    const digest = createHash('sha256').update(state).digest('hex');
    const result = await this.db().query(
      `DELETE FROM nyx_connector_link_states
       WHERE state_digest=$1 AND provider='github' AND expires_at>now()
       RETURNING owner_id,connection_id,installation_id`,
      [digest],
    );
    if (result.rowCount !== 1) throw new Error('CONNECTOR_LINK_STATE_EXPIRED');
    return {
      ownerId:String(result.rows[0].owner_id),
      connectionId:String(result.rows[0].connection_id),
      installationId:String(result.rows[0].installation_id),
    };
  }
  async activateGithub(ownerId:string,id:string,installationId:string,account:string,
    grants:ConnectorCapability[],repos:string[]) {
    const c=await this.owned(ownerId,id);
    if (c.status !== 'pending' || c.provider !== 'github') throw new Error('GITHUB_CONNECTION_NOT_PENDING');
    if (!repos.length || repos.length>500) throw new Error('GITHUB_REPOSITORY_SELECTION_REQUIRED');
    // Authorization grants come from verified provider results, never MCP input.
    const updated:ConnectorConnection={...c,installationId,externalAccountId:account,
      providerCapabilities:grants,resources:[],
      capabilities:[],status:'active'};
    await this.repository!.save(updated);
    return this.view(updated);
  }
}
