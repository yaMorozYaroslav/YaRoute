import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { assertPublicTenantGoogleOwnerId, assertPublicTenantStorageProvider } from './public-tenant-provider.policy';
import { ConnectorRegistry } from './connector-registry';
import { PostgresConnectorRepository } from './postgres-connector-repository';
import { verifiedStorageNamespace } from './storage-identity.policy';

/** Production connectors are intentionally read-only until risk-enforced writes exist. */
export const ENABLED_PROVIDER_API_CAPABILITIES = {
  github: ['repository:metadata','resources:read','contents:write','ci:read','issues:read','issues:write','pulls:read','pulls:write','releases:read'],
} as const;

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
    // Verified provider namespace identity, not labels, secret hashes, or folder
    // paths, is unique per OAuth owner. Identity is attached only by trusted
    // Google/MEGA server-side callbacks (or a reviewed verified importer).
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_storage_verified_identity_v1 (
      connection_id text PRIMARY KEY,
      owner_id text NOT NULL,
      provider text NOT NULL CHECK (provider IN ('google-drive','mega')),
      namespace text NOT NULL,
      external_id text NOT NULL,
      verified_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, provider, namespace)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_link_states (
      state_digest text PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      provider text NOT NULL,
      installation_id text,
      expires_at timestamptz NOT NULL
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS nyx_link_expiry_idx ON nyx_connector_link_states(expires_at)');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_request_limits (
      owner_id text NOT NULL,
      window_hour timestamptz NOT NULL,
      count integer NOT NULL,
      PRIMARY KEY(owner_id,window_hour)
    )`);
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
    assertPublicTenantGoogleOwnerId(value);
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
    return (await this.policy().list(ownerId)).filter(c => c.provider === 'github').map(connection => this.view(connection));
  }
  view(c: ConnectorConnection) {
    const { id, displayName, provider, externalAccountId,
      capabilities, providerCapabilities, resources, status } = c;
    return {
      id, displayName, provider, externalAccountId, capabilities, providerCapabilities,
      resources: resources ?? [], status,
      availableCapabilities: this.enabledCapabilities(provider),
    };
  }
  private enabledCapabilities(provider: ConnectorProvider): ConnectorCapability[] {
    const enabled = provider === 'github' ? ENABLED_PROVIDER_API_CAPABILITIES.github : undefined;
    if (!enabled) return [];
    return [...enabled].filter(cap => SELECTABLE_CONNECTOR_CAPABILITIES.includes(cap) && supportsCapability(provider,cap));
  }
  private assertProductionPermissions(provider: ConnectorProvider, capabilities: ConnectorCapability[]) {
    if (!Array.isArray(capabilities) || capabilities.some(cap => !this.enabledCapabilities(provider).includes(cap))) {
      throw new Error('CONNECTOR_API_CAPABILITY_NOT_READY');
    }
  }
  async create(ownerId: string, provider: ConnectorProvider, name: string) {
    this.owner(ownerId);
    if (provider !== 'github') throw new Error('CONNECTOR_PROVIDER_NOT_READY');
    const connection: ConnectorConnection = {
      id: randomUUID(), ownerId, provider,
      displayName: validateConnectionName(name), externalAccountId: 'pending',
      capabilities: [], providerCapabilities: [], resources: [], status: 'pending',
    };
    const existing=await this.policy().list(ownerId);
    if(existing.filter(c=>c.status!=='revoked').length>=12) {
      throw new Error('CONNECTOR_ACCOUNT_LIMIT');
    }
    await this.repository!.save(connection);
    return this.view(connection);
  }
  async rename(ownerId: string, id: string, name: string) {
    const connection=await this.owned(this.owner(ownerId),id);
    if(connection.provider!=='github')throw new Error('CONNECTOR_PROVIDER_DISABLED');
    return this.view(await this.policy().rename(ownerId, id, name));
  }
  async permissions(ownerId: string, id: string, capabilities: ConnectorCapability[]) {
    const connection = await this.owned(this.owner(ownerId),id);
    if(connection.provider!=='github')throw new Error('CONNECTOR_PROVIDER_DISABLED');
    this.assertProductionPermissions(connection.provider,capabilities);
    const result = await this.policy().setPermissions(ownerId, id, capabilities);
    return {...this.view(result.connection), authorizationRequired: result.authorizationRequired};
  }
  async resources(ownerId: string, id: string, rules: ConnectorResourceRule[]) {
    const connection = await this.owned(this.owner(ownerId),id);
    if(connection.provider!=='github')throw new Error('CONNECTOR_PROVIDER_DISABLED');
    if (!Array.isArray(rules) || rules.some(rule =>
       !rule || !Array.isArray(rule.capabilities) ||
       rule.capabilities.some(cap => !this.enabledCapabilities(connection.provider).includes(cap)))) {
      throw new Error('CONNECTOR_API_CAPABILITY_NOT_READY');
    }
    return this.view(await this.policy().setResources(ownerId, id, rules));
  }
  async disconnect(ownerId: string, id: string) {
    const previous=await this.owned(ownerId,id);
    if(previous.provider!=='github')throw new Error('CONNECTOR_PROVIDER_DISABLED');
    await this.db().query(
      `UPDATE nyx_connector_connections SET status='revoked',
       capabilities='[]'::jsonb, provider_capabilities='[]'::jsonb,
       resources='[]'::jsonb, installation_id=NULL, updated_at=now()
       WHERE id=$1 AND owner_id=$2`,
      [id,ownerId],
    );
    await this.db().query('DELETE FROM nyx_connector_link_states WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,id]);
    return {id,status:'revoked',externalRevocationRequired:true,provider:previous.provider};
  }
  /** Atomic owner-level hourly request budget across all NestJS instances. */
  async consumeQuota(ownerId:string, id:string) {
    const connection=await this.owned(ownerId,id);
    if(connection.provider!=='github')throw new Error('CONNECTOR_PROVIDER_DISABLED');
    const result=await this.db().query(`
      INSERT INTO nyx_connector_request_limits(owner_id,window_hour,count)
      VALUES($1,date_trunc('hour',now()),1)
      ON CONFLICT(owner_id,window_hour)
      DO UPDATE SET count=nyx_connector_request_limits.count+1
      WHERE nyx_connector_request_limits.count < 60
      RETURNING count
    `,[ownerId]);
    if(result.rowCount!==1)throw new Error('CONNECTOR_API_HOURLY_LIMIT');
    return result.rows[0].count as number;
  }

  async getOwned(ownerId:string, id:string) { return this.owned(this.owner(ownerId), id); }
  /**
   * Lazy repository wrapper: Nest constructs provider factories before onModuleInit.
   * Every read/write still fails closed until initialization has succeeded.
   */
  registryPolicy() {
    return new ConnectorRegistry({
      get: async id => { this.db(); return this.repository!.get(id); },
      list: async owner => { this.db(); return this.repository!.list(owner); },
      save: async connection => { this.db(); return this.repository!.save(connection); },
    });
  }


  /** DEV opt-in storage metadata only: no raw credentials or provider grants. */
  private assertTenantStorageMode() {
    if (process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true' ||
        process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true') {
      throw new Error('TENANT_RCLONE_NOT_ENABLED');
    }
  }

  async listStorage(ownerId: string) {
    this.assertTenantStorageMode();
    return (await this.policy().list(this.owner(ownerId)))
      .filter(c => c.provider === 'google-drive' || c.provider === 'mega')
      .map(c => this.view(c));
  }

  async createStorage(ownerId: string, provider: 'google-drive' | 'mega', name: string) {
    this.assertTenantStorageMode();
    assertPublicTenantStorageProvider(provider);
    this.owner(ownerId);
    const existing = await this.policy().list(ownerId);
    if (existing.filter(c => c.status !== 'revoked').length >= 12) {
      throw new Error('CONNECTOR_ACCOUNT_LIMIT');
    }
    const connection: ConnectorConnection = {
      id: randomUUID(), ownerId, provider, displayName: validateConnectionName(name),
      externalAccountId: 'pending', capabilities: [], providerCapabilities: [],
      resources: [], status: 'pending',
    };
    await this.repository!.save(connection);
    return this.view(connection);
  }

  /** Rename either onboarding origin, never touch credentials, grants, or provider account. */
  async renameStorage(ownerId: string, id: string, name: string) {
    this.assertTenantStorageMode();
    const connection=await this.owned(this.owner(ownerId),id);
    assertPublicTenantStorageProvider(connection.provider);
    if (!['google-drive','mega'].includes(connection.provider))
      throw new Error('CONNECTOR_PROVIDER_DISABLED');
    const updated=await this.policy().rename(ownerId,id,name);
    return this.view(updated);
  }

  async storagePermissions(ownerId: string, id: string, capabilities: ConnectorCapability[]) {
    this.assertTenantStorageMode();
    const connection = await this.owned(this.owner(ownerId), id);
    assertPublicTenantStorageProvider(connection.provider);
    if (!['google-drive','mega'].includes(connection.provider)) {
      throw new Error('CONNECTOR_PROVIDER_DISABLED');
    }
    const allowed=connection.provider==='mega' &&
      process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true'
      ? ['storage:list','storage:move','storage:delete'] : ['storage:list'];
    if (!Array.isArray(capabilities) ||
        capabilities.some(c => !allowed.includes(c))) {
      throw new Error('TENANT_RCLONE_READ_ONLY');
    }
    const updated = await this.policy().setPermissions(ownerId, id, capabilities);
    return {...this.view(updated.connection), authorizationRequired: updated.authorizationRequired};
  }

  async storageResources(ownerId: string, id: string, resources: ConnectorResourceRule[]) {
    this.assertTenantStorageMode();
    const connection = await this.owned(this.owner(ownerId), id);
    assertPublicTenantStorageProvider(connection.provider);
    if (!['google-drive','mega'].includes(connection.provider)) {
      throw new Error('CONNECTOR_PROVIDER_DISABLED');
    }
    // Initial MEGA pilot verifies one exact user-owned root per connection.
    // Empty selection is permitted to revoke access, but not to enroll.
    if (connection.provider === 'mega' && Array.isArray(resources) && resources.length > 1)
      throw new Error('TENANT_MEGA_SINGLE_ROOT_REQUIRED');
    const allowed=connection.provider==='mega' &&
      process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true'
      ? ['storage:list','storage:move','storage:delete'] : ['storage:list'];
    if (!Array.isArray(resources) || resources.length > 10 ||
        resources.some(r => !r || r.kind !== (connection.provider === 'mega' ? 'mega-root' : 'drive') ||
          !Array.isArray(r.capabilities) || r.capabilities.some(c => !allowed.includes(c)) ||
          r.branches !== undefined || r.pathPrefix !== undefined ||
          typeof r.id !== 'string' || r.id.length > 256 ||
          !/^[A-Za-z0-9_.\\/-]+$/.test(r.id) || r.id.split('/').some(p => p === '..' || p === '.'))) {
      throw new Error('TENANT_RCLONE_RESOURCE_INVALID');
    }
    const updated = await this.policy().setResources(ownerId, id, resources);
    return this.view(updated);
  }

  /**
   * Called ONLY by the isolated Rclone worker AFTER it successfully lists an
   * imported pending connection and checks provider identity. Does NOT activate,
   * grant permissions, overwrite a different namespace, or accept MCP claims.
   */
  async attestImportedPendingStorageIdentity(
    ownerId:string,id:string,provider:'google-drive'|'mega',
    verifiedAccountId:string,verifiedDriveId?:string|null,
  ) {
    this.assertTenantStorageMode();
    const owner=this.owner(ownerId);
    const connection=await this.owned(owner,id);
    if(connection.status!=='pending'||connection.externalAccountId!=='pending'||
       connection.provider!==provider)throw new Error('TENANT_IMPORT_NOT_PENDING');
    if(provider==='google-drive' && verifiedDriveId===undefined)
      throw new Error('TENANT_DRIVE_NAMESPACE_ATTESTATION_REQUIRED');
    const namespace=verifiedStorageNamespace(provider,verifiedAccountId,verifiedDriveId);
    const client=await this.db().connect();
    try{
      await client.query('BEGIN');
      const claim=await client.query(
        'INSERT INTO nyx_storage_verified_identity_v1 '+
        '(connection_id,owner_id,provider,namespace,external_id) '+
        'VALUES($1,$2,$3,$4,$5) '+
        'ON CONFLICT(connection_id) DO UPDATE SET verified_at=now() '+
        'WHERE nyx_storage_verified_identity_v1.owner_id=EXCLUDED.owner_id '+
        'AND nyx_storage_verified_identity_v1.provider=EXCLUDED.provider '+
        'AND nyx_storage_verified_identity_v1.namespace=EXCLUDED.namespace '+
        'AND nyx_storage_verified_identity_v1.external_id=EXCLUDED.external_id '+
        'RETURNING connection_id',
        [id,owner,provider,namespace,verifiedAccountId]);
      if(claim.rowCount!==1)throw new Error('TENANT_IMPORT_IDENTITY_CHANGED');
      await client.query('COMMIT');
      return {status:'provider_identity_attested' as const, connectionId:id,
        provider,readGrantsAdded:false};
    }catch(error){
      await client.query('ROLLBACK').catch(()=>{});
      if((error as {code?:string})?.code==='23505')
        throw new Error('STORAGE_DUPLICATE_DRIVE_ALREADY_CONNECTED');
      throw error;
    }finally{client.release();}
  }

  /** Trusted server-side provider verification only; never an MCP input. */
  async confirmStorageProvider(ownerId: string, id: string,
                               provider: 'google-drive' | 'mega', verifiedAccountId: string,
                               verifiedDriveId?: string | null, verifiedGooglePermissionId?:string) {
    this.assertTenantStorageMode();
    const connection = await this.owned(this.owner(ownerId), id);
    assertPublicTenantStorageProvider(connection.provider);
    if (connection.provider !== provider || connection.status === 'revoked' ||
        !/^[A-Za-z0-9_.:@-]{1,256}$/.test(verifiedAccountId)) {
      throw new Error('TENANT_RCLONE_PROVIDER_IDENTITY_INVALID');
    }
    if (connection.status === 'active' &&
        connection.externalAccountId !== verifiedAccountId) {
      throw new Error('TENANT_RCLONE_ACCOUNT_CHANGE_FORBIDDEN');
    }
    if (provider === 'google-drive' && verifiedDriveId === undefined)
      throw new Error('TENANT_DRIVE_NAMESPACE_ATTESTATION_REQUIRED');
    // Imported Rclone usually carries Drive scope but not OpenID identity.
    // Drive about.user.permissionId is available to both OAuth and imported
    // credentials, so the SAME Google Drive dedupe namespace is used.
    if(provider==='google-drive' &&
      (!verifiedGooglePermissionId ||
       !/^[A-Za-z0-9_-]{1,256}$/.test(verifiedGooglePermissionId)))
      throw new Error('TENANT_GOOGLE_PERMISSION_ID_REQUIRED');
    const namespace=verifiedStorageNamespace(provider,
      provider==='google-drive' ? verifiedGooglePermissionId! : verifiedAccountId,
      verifiedDriveId);
    const verified: ConnectorConnection = {
      ...connection, externalAccountId: verifiedAccountId,
      // Provider consent grants only metadata for read-only operations.
      // User-enabled capabilities and chosen resources remain separate.
      providerCapabilities: provider==='mega' &&
        process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true'
        ? ['storage:list','storage:move','storage:delete'] : ['storage:list'],
      status: 'active',
    };
    const client=await this.db().connect();
    try {
      await client.query('BEGIN');
      const claim=await client.query(
        'INSERT INTO nyx_storage_verified_identity_v1 ' +
        '(connection_id,owner_id,provider,namespace,external_id) ' +
        'VALUES($1,$2,$3,$4,$5) ' +
        'ON CONFLICT(connection_id) DO UPDATE SET ' +
        'external_id=EXCLUDED.external_id,verified_at=now() ' +
        'WHERE nyx_storage_verified_identity_v1.owner_id=EXCLUDED.owner_id ' +
        'AND nyx_storage_verified_identity_v1.provider=EXCLUDED.provider ' +
        'AND nyx_storage_verified_identity_v1.namespace=EXCLUDED.namespace ' +
        'RETURNING connection_id',
        [id,ownerId,provider,namespace,verifiedAccountId]);
      if(claim.rowCount!==1)throw new Error('STORAGE_NAMESPACE_CHANGE_REQUIRES_NEW_CONNECTION');
      await this.repository!.save(verified,client);
      await client.query('COMMIT');
    }catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      if((error as {code?:string})?.code==='23505')
        throw new Error('STORAGE_DUPLICATE_DRIVE_ALREADY_CONNECTED');
      throw error;
    }finally{client.release();}
    return this.view(verified);
  }

  async beginGithub(ownerId:string, id:string, installationId?:string) {
    await this.consumeQuota(ownerId,id);
    const c = await this.owned(ownerId,id);
    if (c.provider !== 'github' || c.status !== 'pending') throw new Error('GITHUB_CONNECTION_NOT_PENDING');
    // Auto discovery is server-selected and verified on OAuth callback.
    if (installationId!==undefined && !/^[1-9][0-9]{0,19}$/.test(installationId)) {
      throw new Error('GITHUB_INSTALLATION_INVALID');
    }
    const installationSelection=installationId ?? 'auto';
    const clientId = process.env.NYX_GITHUB_CLIENT_ID;
    const publicUrl = process.env.NYX_PUBLIC_URL;
    if (!clientId || !/^[a-zA-Z0-9_.-]+$/.test(clientId) ||
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
      [digest,ownerId,id,installationSelection],
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id',clientId);
    url.searchParams.set('redirect_uri',publicUrl.replace(/\/$/,'')+'/connect/github/callback');
    url.searchParams.set('state',state);
    // GitHub App user authorization. No extra classic OAuth scopes requested.
    return {url:url.toString(),expiresInSeconds:600,
      message:'Authorize GitHub; NestNyx will verify the GitHub App installation automatically. No manual installation ID is required.'};
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
