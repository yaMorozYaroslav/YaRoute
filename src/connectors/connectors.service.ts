import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { googleCallbackUrl, googleOAuthConfiguration, revokeGoogleDriveProfile } from './google-drive-oauth-config';
import { Pool } from 'pg';
import { StorageService } from '../storage/storage.service';
import { RcloneCredentialVaultService } from '../storage/rclone-credential-vault.service';
import { ConnectorRegistry } from './connector-registry';
import { PostgresConnectorRepository } from './postgres-connector-repository';

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
  constructor(private readonly storage: StorageService,
    @Optional() private readonly vault?: RcloneCredentialVaultService) {}

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
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_connector_request_limits (
      owner_id text NOT NULL,
      window_hour timestamptz NOT NULL,
      count integer NOT NULL,
      PRIMARY KEY(owner_id,window_hour)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_google_drive_oauth_states (
      state_digest text PRIMARY KEY,
      owner_id text NOT NULL,
      connection_id text NOT NULL,
      code_verifier text NOT NULL,
      expires_at timestamptz NOT NULL
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS nyx_google_oauth_expiry_idx ON nyx_google_drive_oauth_states(expires_at)');
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
    const showRclone = process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
      (process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' && this.vault?.isEnabled());
    return (await this.policy().list(ownerId))
      .filter(c => c.provider === 'github' ||
        (showRclone && (c.provider === 'google-drive' || c.provider === 'mega')))
      .map(connection => this.view(connection));
  }
  view(c: ConnectorConnection) {
    const { id, displayName, provider, externalAccountId,
      capabilities, providerCapabilities, resources, status } = c;
    return {
      id, displayName, provider, externalAccountId, capabilities, providerCapabilities,
      resources: resources ?? [], status,
      availableCapabilities: this.enabledCapabilities(provider),
      ...(provider === 'google-drive' || provider === 'mega'
        ? { connectionType: this.vault?.isEnabled() ? 'isolated-credential-vault' : 'private-rclone-reference',
            configurationChanged: false,
            verification: this.vault?.isEnabled() ? 'credentials_unverified' : 'configured_not_live_verified' } : {}),
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
    if(existing.filter(c=>c.status!=='revoked').length>=30 ||
       existing.filter(c=>c.provider==='github'&&c.status!=='revoked').length>=12) {
      throw new Error('CONNECTOR_ACCOUNT_LIMIT');
    }
    await this.repository!.save(connection);
    return this.view(connection);
  }
  /**
   * Owner-scoped reference to a preconfigured Rclone remote, NOT an OAuth grant.
   * Shares Neon DATABASE_URL with the existing GitHub connection registry;
   * no credentials, config bytes or provider tokens are persisted here.
   */
  async createRclone(ownerId: string, provider: 'google-drive' | 'mega',
    remoteName: string, displayName: string) {
    const owner = this.owner(ownerId);
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        (process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' || !this.vault?.isEnabled())) {
      throw new Error('PUBLIC_RCLONE_VAULT_REQUIRED');
    }
    if (!['google-drive','mega'].includes(provider) ||
        typeof remoteName !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remoteName)) {
      throw new Error('RCLONE_REMOTE_INVALID');
    }
    if (!this.vault?.isEnabled()) {
      const inventory = await this.storage.rcloneConnections();
      if (!inventory.remotes.some(remote => remote.provider === provider && remote.name === remoteName)) {
        throw new Error('RCLONE_REMOTE_NOT_CONFIGURED');
      }
    }
    const existing = await this.policy().list(owner);
    if (existing.filter(c => c.status !== 'revoked').length >= 30) {
      throw new Error('CONNECTOR_ACCOUNT_LIMIT');
    }
    if (existing.some(c => c.provider === provider &&
        c.externalAccountId === remoteName && c.status !== 'revoked')) {
      throw new Error('RCLONE_REMOTE_ALREADY_LINKED');
    }
    const connection: ConnectorConnection = {
      id: randomUUID(), ownerId: owner, provider, displayName: validateConnectionName(displayName),
      externalAccountId: remoteName, capabilities: [], providerCapabilities: [],
      resources: [], status: 'pending',
    };
    await this.repository!.save(connection);
    return this.view(connection);
  }


  /**
   * Verified OAuth subject starts a Google read-only consent flow.
   * State and PKCE verifier live in Neon for at most ten minutes;
   * only their derived challenge and opaque state leave the server.
   */
  async beginGoogleDrive(ownerId:string,id:string) {
    const owner=this.owner(ownerId);
    if (!this.vault?.isEnabled()) throw new Error('RCLONE_VAULT_NOT_CONFIGURED');
    const c=await this.owned(owner,id);
    if(c.provider!=='google-drive' || c.status==='revoked') throw new Error('GOOGLE_CONNECTION_UNAVAILABLE');
    const {clientId}=googleOAuthConfiguration();
    const state=randomBytes(32).toString('base64url');
    const verifier=randomBytes(32).toString('base64url');
    const digest=createHash('sha256').update(state).digest('hex');
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    await this.db().query(
      'INSERT INTO nyx_google_drive_oauth_states(state_digest,owner_id,connection_id,code_verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\')',
      [digest,owner,id,verifier]);
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',clientId);
    url.searchParams.set('redirect_uri',googleCallbackUrl());
    url.searchParams.set('response_type','code');
    url.searchParams.set('scope','https://www.googleapis.com/auth/drive.readonly');
    url.searchParams.set('access_type','offline');
    url.searchParams.set('prompt','consent');
    url.searchParams.set('code_challenge',challenge);
    url.searchParams.set('code_challenge_method','S256');
    url.searchParams.set('state',state);
    return {connectionId:id,provider:'google-drive',authorizationUrl:url.toString(),
      expiresInSeconds:600,scope:'drive.readonly',credentialsShared:false};
  }
  async consumeGoogleDriveState(state:string) {
    if(typeof state!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      throw new Error('GOOGLE_OAUTH_STATE_INVALID');
    }
    const digest=createHash('sha256').update(state).digest('hex');
    const q=await this.db().query(
      'DELETE FROM nyx_google_drive_oauth_states WHERE state_digest=$1 AND expires_at>now() RETURNING owner_id,connection_id,code_verifier',
      [digest]);
    if(q.rowCount!==1)throw new Error('GOOGLE_OAUTH_STATE_EXPIRED');
    const row=q.rows[0];
    const c=await this.owned(row.owner_id,row.connection_id);
    if(c.provider!=='google-drive'||c.status==='revoked')throw new Error('GOOGLE_CONNECTION_UNAVAILABLE');
    return {ownerId:c.ownerId,connectionId:c.id,remote:c.externalAccountId,
      verifier:String(row.code_verifier)};
  }
  async activateGoogleDrive(ownerId:string,id:string) {
    const c=await this.owned(ownerId,id);
    if(c.provider!=='google-drive'||c.status==='revoked')throw new Error('GOOGLE_CONNECTION_UNAVAILABLE');
    const q=await this.db().query(
      "UPDATE nyx_connector_connections SET status='active',updated_at=now() WHERE id=$1 AND owner_id=$2 AND provider='google-drive' AND status='pending' RETURNING id",
      [id,ownerId]);
    // Reauthorizing an active connection is allowed; its owner remains unchanged.
    if(!q.rowCount && c.status!=='active')throw new Error('GOOGLE_CONNECTION_NOT_ACTIVATED');
    return {id,status:'active',provider:'google-drive'};
  }

  async testRclone(ownerId: string, id: string) {
    const connection = await this.owned(this.owner(ownerId), id);
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        (process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' || !this.vault?.isEnabled())) {
      throw new Error('PUBLIC_RCLONE_VAULT_REQUIRED');
    }
    if (connection.status === 'revoked' ||
        (connection.provider !== 'google-drive' && connection.provider !== 'mega')) {
      throw new Error('RCLONE_CONNECTION_NOT_AVAILABLE');
    }
    if (this.vault?.isEnabled()) {
      const profile=await this.vault.load(ownerId,connection.id,connection.provider,
        connection.externalAccountId);
      if (!profile) return {connectionId:connection.id,
        schema:'nyx.storage.rclone.probe.v1',provider:connection.provider,
        name:connection.externalAccountId,status:'unverified',
        reason:'ISOLATED_CREDENTIAL_NOT_PROVISIONED',configurationChanged:false};
      return {connectionId:connection.id,...await this.storage.testIsolatedRcloneConnection(
        connection.provider,connection.externalAccountId,profile)};
    }
    return { connectionId: connection.id,
      ...await this.storage.testRcloneConnection(connection.provider, connection.externalAccountId) };
  }

  async rename(ownerId: string, id: string, name: string) {
    const connection=await this.owned(this.owner(ownerId),id);
    if (connection.provider !== 'github' &&
        !(['google-drive','mega'].includes(connection.provider) &&
          (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
           (process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' && this.vault?.isEnabled())))) {
      throw new Error('CONNECTOR_PROVIDER_DISABLED');
    }
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
    if (previous.provider !== 'github' &&
        !(['google-drive','mega'].includes(previous.provider) &&
          (process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
           (process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' && this.vault?.isEnabled())))) {
      throw new Error('CONNECTOR_PROVIDER_DISABLED');
    }
    let providerRevoked=false;
    // Best effort provider-side Google token revocation happens *before*
    // local ciphertext destruction. Errors never expose tokens to callers.
    if(previous.provider==='google-drive' && this.vault?.isEnabled()){
      const profile=await this.vault.load(ownerId,id,'google-drive',previous.externalAccountId);
      if(profile)providerRevoked=await revokeGoogleDriveProfile(profile);
    }
    if(previous.provider==='google-drive'||previous.provider==='mega'){
      // If vault deletion fails, do not claim unlink completed.
      await this.vault?.revoke(ownerId,id);
    }
    await this.db().query(
      `UPDATE nyx_connector_connections SET status='revoked',
       capabilities='[]'::jsonb, provider_capabilities='[]'::jsonb,
       resources='[]'::jsonb, installation_id=NULL, updated_at=now()
       WHERE id=$1 AND owner_id=$2`,
      [id,ownerId],
    );
    await this.db().query('DELETE FROM nyx_connector_link_states WHERE owner_id=$1 AND connection_id=$2',
      [ownerId,id]);
    return {id,status:'revoked',
      externalRevocationRequired:previous.provider==='google-drive' ? !providerRevoked : true,
      providerRevoked:previous.provider==='google-drive' && providerRevoked,
      provider:previous.provider,configurationChanged:false,
      metadataOnly:previous.provider !== 'github'};
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

  async beginGithub(ownerId:string, id:string, installationId:string) {
    await this.consumeQuota(ownerId,id);
    const c = await this.owned(ownerId,id);
    if (c.provider !== 'github' || c.status !== 'pending') throw new Error('GITHUB_CONNECTION_NOT_PENDING');
    if (!/^[1-9][0-9]{0,19}$/.test(installationId)) throw new Error('GITHUB_INSTALLATION_INVALID');
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
