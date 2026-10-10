import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';

export interface HerokuCredentials {
  tokenFor(ownerId: string, connectionId: string): Promise<string>;
}
/** Read-only Heroku Platform API; config variable VALUES are never returned. */
export class HerokuReadonlyConnector {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly credentials: HerokuCredentials,
    private readonly http: typeof fetch = fetch,
  ) {}
  private async get(owner: string, connectionId: string, app: string, capability: ConnectorCapability, suffix: string) {
    if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(app)) throw new Error('HEROKU_APP_INVALID');
    await this.registry.requireResource(owner, connectionId, capability, {kind:'heroku-app', id:app});
    const token = await this.credentials.tokenFor(owner, connectionId);
    if (!token) throw new Error('HEROKU_AUTH_UNAVAILABLE');
    const response = await this.http('https://api.heroku.com/apps/' + encodeURIComponent(app) + suffix, {
      method:'GET',
      headers:{Authorization:'Bearer ' + token,Accept:'application/vnd.heroku+json; version=3'},
      redirect:'error',
      signal:AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('HEROKU_API_FAILED');
    return response.json();
  }
  async appInfo(owner:string,connectionId:string,app:string) {
    const data = await this.get(owner,connectionId,app,'heroku:apps:read','');
    return {name:data.name,id:data.id,web_url:data.web_url,region:data.region?.name};
  }
  async releases(owner:string,connectionId:string,app:string) {
    const data = await this.get(owner,connectionId,app,'heroku:releases:read','/releases');
    if (!Array.isArray(data)) throw new Error('HEROKU_RESPONSE_INVALID');
    return data.slice(0,50).map(x=>({id:x.id,version:x.version,created_at:x.created_at,current:x.current}));
  }
  async configNames(owner:string,connectionId:string,app:string) {
    const data = await this.get(owner,connectionId,app,'heroku:config:names','/config-vars');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('HEROKU_RESPONSE_INVALID');
    return Object.keys(data).sort(); // NEVER return values.
  }
}
