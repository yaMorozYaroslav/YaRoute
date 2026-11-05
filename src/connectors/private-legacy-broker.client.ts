import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrivateLegacyOwnerLinkService } from './private-legacy-owner-link.service';
import { privateBrokerKey, privateBrokerPath, privateBrokerRoot,
  signPrivateBrokerDelegation, type PrivateBrokerClaims,
  type PrivateBrokerOperation } from './private-legacy-delegation';

/** Public-only client. Holds a delegation key, never the operator's Rclone config. */
@Injectable()
export class PrivateLegacyBrokerClient {
  constructor(private readonly ownerLink: PrivateLegacyOwnerLinkService) {}

  private settings() {
    if (process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED !== 'true' ||
        process.env.NYX_DEPLOYMENT_MODE !== 'public' ||
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true' ||
        process.env.NYX_MULTIUSER_RCLONE_ENABLED !== 'true' ||
        process.env.NYX_PRIVATE_OWNER_LINK_ENABLED !== 'true')
      throw new Error('PRIVATE_BROKER_CLIENT_DISABLED');
    if (['RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH','RCLONE_CONFIG',
          'NYX_SHARED_ROOTS_JSON'].some(name => Boolean(process.env[name]?.trim())))
      throw new Error('PRIVATE_BROKER_LEGACY_CONFIG_FORBIDDEN');
    const origin = (process.env.NYX_PUBLIC_URL || '').replace(/\/$/, '');
    const destination = (process.env.NYX_PRIVATE_BROKER_URL || '').replace(/\/$/, '');
    const key = process.env.NYX_PRIVATE_BROKER_SHARED_KEY_B64 || '';
    privateBrokerKey(key);
    const url = new URL(destination);
    if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(origin) ||
        url.protocol !== 'https:' || url.pathname !== '/' ||
        url.username || url.password || url.search || url.hash ||
        !url.hostname.endsWith('.herokuapp.com') ||
        url.hostname === 'herokuapp.com' || url.origin === origin)
      throw new Error('PRIVATE_BROKER_TARGET_INVALID');
    return {origin,url:url.origin+'/internal/private-legacy/execute',key};
  }

  private async invoke(ownerId: string, op: PrivateBrokerOperation,
                       root = '', relativePath = '') {
    const cfg = this.settings();
    if (op === 'list') {
      privateBrokerRoot(root);
      privateBrokerPath(relativePath);
    } else if (root !== '' || relativePath !== '') {
      throw new Error('PRIVATE_BROKER_ARGUMENTS_DENIED');
    }
    const identity = await this.ownerLink.trustedBrokerIdentity(ownerId);
    const now = Math.floor(Date.now()/1000);
    const proof: PrivateBrokerClaims = {
      v:1,iss:cfg.origin,aud:cfg.url,
      mcpIssuer:identity.mcpIssuer,mcpSubject:identity.mcpSubject,
      googleSubject:identity.googleSubject,op,root,path:relativePath,
      jti:randomBytes(16).toString('hex'),iat:now,exp:now+30,
    };
    const delegation = signPrivateBrokerDelegation(proof,cfg.key,now);
    const response = await fetch(cfg.url,{
      method:'POST',
      headers:{authorization:'NyxBroker '+delegation,'content-type':'application/json'},
      body:'{}',
      redirect:'error',
      signal:AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    if (!response.ok || raw.length > 131072)
      throw new Error('PRIVATE_BROKER_UNAVAILABLE');
    let result: unknown;
    try { result = JSON.parse(raw); }
    catch { throw new Error('PRIVATE_BROKER_RESPONSE_INVALID'); }
    if (!result || typeof result !== 'object' ||
        (result as {schema?:unknown}).schema !== 'nyx.private-legacy-broker.v1')
      throw new Error('PRIVATE_BROKER_RESPONSE_INVALID');
    const data = result as Record<string,unknown>;
    if (op === 'roots') {
      if (!Array.isArray(data.roots) || data.roots.length > 20 ||
          !data.roots.every(r => typeof r === 'string' &&
            /^[A-Z][A-Z0-9_]{0,39}$/.test(r)))
        throw new Error('PRIVATE_BROKER_RESPONSE_INVALID');
      return {schema:data.schema,roots:data.roots};
    }
    if (!Array.isArray(data.entries) || data.entries.length > 100 ||
        !data.entries.every(e => e && typeof e === 'object' &&
          typeof e.name === 'string' && e.name.length <= 255 &&
          typeof e.isDir === 'boolean' &&
          typeof e.size === 'number' && Number.isFinite(e.size)))
      throw new Error('PRIVATE_BROKER_RESPONSE_INVALID');
    return {schema:data.schema,root,path:relativePath,entries:data.entries};
  }

  async roots(ownerId: string) { return this.invoke(ownerId,'roots'); }
  async list(ownerId: string, root: string, path = '') {
    return this.invoke(ownerId,'list',root,path);
  }
}
