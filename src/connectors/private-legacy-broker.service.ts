import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { StorageService } from '../storage/storage.service';
import { privateBrokerKey, verifyPrivateBrokerDelegation } from
  './private-legacy-delegation';

/** Private-only, read-only facade over explicit operator-approved area aliases. */
@Injectable()
export class PrivateLegacyBrokerService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;

  constructor(private readonly storage: StorageService) {}

  private settings() {
    if (process.env.NYX_PRIVATE_BROKER_SERVER_ENABLED !== 'true' ||
        process.env.NYX_DEPLOYMENT_MODE !== 'private')
      throw new Error('PRIVATE_BROKER_SERVER_DISABLED');
    const here = (process.env.NYX_PUBLIC_URL || '').replace(/\/$/, '');
    const expectedPublic = (process.env.NYX_PRIVATE_BROKER_EXPECTED_PUBLIC_URL || '').replace(/\/$/, '');
    const mcpIssuer = (process.env.NYX_OAUTH_ISSUER || '').trim();
    const mcpSubject = (process.env.NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT || '').trim();
    const googleSubject = (process.env.NYX_PRIVATE_BROKER_GOOGLE_SUBJECT || '').trim();
    const key = process.env.NYX_PRIVATE_BROKER_SHARED_KEY_B64 || '';
    const rawAreas = process.env.NYX_PRIVATE_BROKER_ALLOWED_AREAS || '';
    const areas = rawAreas.split(',').map(s => s.trim()).filter(Boolean);
    const allowlist = (process.env.NYX_PRIVATE_OAUTH_SUBJECTS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    privateBrokerKey(key);
    if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(here) ||
        !/^https:\/\/[A-Za-z0-9.-]+$/.test(expectedPublic) ||
        here === expectedPublic ||
        !/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(mcpIssuer) ||
        !/^[^\x00-\x20]{1,500}$/.test(mcpSubject) ||
        !/^[A-Za-z0-9_-]{5,255}$/.test(googleSubject) ||
        allowlist.length !== 1 || allowlist[0] !== mcpSubject ||
        areas.length < 1 || areas.length > 20 ||
        new Set(areas).size !== areas.length ||
        !areas.every(a => /^[A-Z][A-Z0-9_]{0,39}$/.test(a)) ||
        !process.env.DATABASE_URL)
      throw new Error('PRIVATE_BROKER_CONFIGURATION_INVALID');
    return {here,expectedPublic,mcpIssuer,mcpSubject,googleSubject,
      key,areas};
  }

  async onModuleInit() {
    if (process.env.NYX_PRIVATE_BROKER_SERVER_ENABLED !== 'true') return;
    this.settings();
    this.pool = new Pool({connectionString:process.env.DATABASE_URL,max:2});
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_private_broker_replay_v1 (
      jti text PRIMARY KEY, expires_at timestamptz NOT NULL)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nyx_private_broker_rate_v1 (
      mcp_subject text NOT NULL, minute timestamptz NOT NULL, count integer NOT NULL,
      PRIMARY KEY (mcp_subject,minute))`);
  }
  async onModuleDestroy() { await this.pool?.end(); }

  async execute(authorization: unknown): Promise<Record<string, unknown>> {
    const cfg = this.settings();
    if (!this.pool || typeof authorization !== 'string' ||
        !authorization.startsWith('NyxBroker '))
      throw new Error('PRIVATE_BROKER_ACCESS_DENIED');
    const claims = verifyPrivateBrokerDelegation(authorization.slice(10),cfg.key,{
      issuer:cfg.expectedPublic,
      audience:cfg.here+'/internal/private-legacy/execute',
      mcpIssuer:cfg.mcpIssuer,
      mcpSubject:cfg.mcpSubject,
      googleSubject:cfg.googleSubject,
    });
    if (claims.op === 'list' && !cfg.areas.includes(claims.root))
      throw new Error('PRIVATE_BROKER_ACCESS_DENIED');
    // Globally one-use even across dynos. Rate limiting is atomic in Postgres.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const used = await client.query(`INSERT INTO nyx_private_broker_replay_v1
        (jti,expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT DO NOTHING
        RETURNING jti`,[claims.jti,claims.exp]);
      if (used.rowCount !== 1) throw new Error('PRIVATE_BROKER_ACCESS_DENIED');
      const usage = await client.query(`INSERT INTO nyx_private_broker_rate_v1
        (mcp_subject,minute,count)
        VALUES($1,date_trunc('minute',now()),1)
        ON CONFLICT (mcp_subject,minute) DO UPDATE SET
          count=nyx_private_broker_rate_v1.count+1 RETURNING count`,
        [cfg.mcpSubject]);
      const requestCount = Number(usage.rows[0]?.count);
      if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 20)
        throw new Error('PRIVATE_BROKER_RATE_LIMITED');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }

    if (claims.op === 'roots')
      return {schema:'nyx.private-legacy-broker.v1',roots:[...cfg.areas]};
    try {
      const raw = await this.storage.list(claims.root,claims.path);
      if (!Array.isArray(raw) || raw.length > 5000)
        throw new Error('PRIVATE_BROKER_BACKEND_UNAVAILABLE');
      const entries = raw.slice(0,100).map((entry:unknown) => {
        if (!entry || typeof entry !== 'object')
          throw new Error('PRIVATE_BROKER_BACKEND_UNAVAILABLE');
        const item = entry as {Name?:unknown;Size?:unknown;IsDir?:unknown};
        if (typeof item.Name !== 'string' || item.Name.length > 255 ||
            /[\x00-\x1f]/.test(item.Name) || typeof item.IsDir !== 'boolean' ||
            typeof item.Size !== 'number' || !Number.isFinite(item.Size))
          throw new Error('PRIVATE_BROKER_BACKEND_UNAVAILABLE');
        return {name:item.Name,isDir:item.IsDir,size:item.Size};
      });
      return {schema:'nyx.private-legacy-broker.v1',entries};
    } catch {
      throw new Error('PRIVATE_BROKER_BACKEND_UNAVAILABLE');
    }
  }
}
