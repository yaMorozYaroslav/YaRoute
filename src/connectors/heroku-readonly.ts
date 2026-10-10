import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';
import { assertNoFinancialAccess, isFinanciallyProhibited } from './financial-safety';

/**
 * Out-of-process Heroku read broker interface. The NestNyx runtime MUST NOT
 * receive a broad Heroku bearer token that can access billing or paid plans.
 *
 * The independent broker MUST enforce its own authenticated owner, app allowlist,
 * fixed read-only Platform API endpoints, and non-financial capability policy.
 * Never expose an arbitrary URL, path, method or CLI command through this port.
 */
export interface HerokuReadBroker {
  appInfo(ownerId: string, connectionId: string, app: string): Promise<{
    id?: string; name?: string; web_url?: string; region?: string;
  }>;
  releases(ownerId: string, connectionId: string, app: string): Promise<Array<{
    id?: string; version?: number; created_at?: string; current?: boolean;
  }>>;
  /** Return names ONLY from broker. Config values must not cross the boundary. */
  configNames(ownerId: string, connectionId: string, app: string): Promise<string[]>;
}

/** Safe metadata facade: no credentials or unrestricted HTTP access in NestNyx. */
export class HerokuReadonlyConnector {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly broker: HerokuReadBroker,
  ) {}

  private async authorize(ownerId: string, connectionId: string, app: string, capability: ConnectorCapability) {
    assertNoFinancialAccess(capability);
    if (typeof app !== 'string' || !/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(app)) {
      throw new Error('HEROKU_APP_INVALID');
    }
    const connection = await this.registry.requireResource(ownerId, connectionId, capability, {
      kind: 'heroku-app', id: app,
    });
    if (connection.provider !== 'heroku') throw new Error('HEROKU_PROVIDER_INVALID');
  }

  async appInfo(ownerId: string, connectionId: string, app: string) {
    await this.authorize(ownerId, connectionId, app, 'heroku:apps:read');
    const data = await this.broker.appInfo(ownerId, connectionId, app);
    if (!data || typeof data !== 'object') throw new Error('HEROKU_RESPONSE_INVALID');
    return { name: data.name, id: data.id, web_url: data.web_url, region: data.region };
  }

  async releases(ownerId: string, connectionId: string, app: string) {
    await this.authorize(ownerId, connectionId, app, 'heroku:releases:read');
    const data = await this.broker.releases(ownerId, connectionId, app);
    if (!Array.isArray(data)) throw new Error('HEROKU_RESPONSE_INVALID');
    return data.slice(0, 50).map(item => ({
      id: item.id, version: item.version, created_at: item.created_at, current: item.current,
    }));
  }

  async configNames(ownerId: string, connectionId: string, app: string) {
    await this.authorize(ownerId, connectionId, app, 'heroku:config:names');
    const names = await this.broker.configNames(ownerId, connectionId, app);
    if (!Array.isArray(names) || names.length > 1000 ||
      names.some(name => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))) {
      throw new Error('HEROKU_RESPONSE_INVALID');
    }
    // Even configuration KEY NAMES that identify payment integrations stay hidden.
    return [...new Set(names)].filter(name => !isFinanciallyProhibited(name)).sort();
  }
}
