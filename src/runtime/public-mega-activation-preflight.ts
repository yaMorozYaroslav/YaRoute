import fs from 'node:fs';
import path from 'node:path';

/**
 * READ ONLY. Check the environment of a proposed SEPARATE public pilot.
 * Neither contacts Heroku nor OAuth issuers, nor reads/prints secret values.
 * A passing result is NOT evidence of live identity/provider acceptance.
 */
function httpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname ||
        url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.port && url.port !== '443') return '';
    if (/^(localhost|127\.|10\.|192\.168\.)/i.test(url.hostname)) return '';
    return url.origin;
  } catch { return ''; }
}
function postgresUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      Boolean(url.hostname && url.pathname && url.pathname !== '/') &&
      !/^(localhost|127\.0\.0\.1)$/i.test(url.hostname);
  } catch { return false; }
}
function aes32(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
}

export function publicMegaActivationPreflight(
  env: Readonly<Record<string,string|undefined>> = process.env,
  options: { existingPrivateOrigin?: string; exists?: (path: string) => boolean } = {},
) {
  const blockers: string[] = [];
  const check = (condition: boolean, code: string): void => {
    if (!condition) blockers.push(code);
  };
  const current = httpsOrigin(env.NYX_PUBLIC_URL);
  // In the two-app cutover Pro stays private and Dev becomes public.
  // Never compare the public app to its own historical private Dev URL.
  const existingPrivate = httpsOrigin(options.existingPrivateOrigin);
  check(env.NYX_DEPLOYMENT_MODE === 'public', 'PUBLIC_DEPLOYMENT_MODE_REQUIRED');
  check(env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true', 'PUBLIC_CONNECTORS_REQUIRED');
  check(env.NYX_MULTIUSER_RCLONE_ENABLED === 'true', 'TENANT_RCLONE_REQUIRED');
  // Both supported public modes require Google login. Enforce an
  // unambiguous provider choice, never a silently permissive fallback.
  const megaOnly = env.NYX_PUBLIC_TENANT_MEGA_ONLY === 'true';
  const googleMulti = env.NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED === 'true';
  check(megaOnly !== googleMulti, 'EXACTLY_ONE_TENANT_PROVIDER_MODE_REQUIRED');

  check(Boolean(current), 'DEDICATED_HTTPS_PUBLIC_ORIGIN_REQUIRED');
  check(Boolean(existingPrivate), 'EXISTING_PRIVATE_ORIGIN_EVIDENCE_REQUIRED');
  check(Boolean(current) && Boolean(existingPrivate) &&
        current !== existingPrivate, 'PUBLIC_ORIGIN_MUST_DIFFER_FROM_PRIVATE_PRO');
  check(env.NYX_SERVICE_NAME === 'NestNyxPublicPilot', 'PUBLIC_PILOT_SERVICE_ID_REQUIRED');
  check(Boolean(httpsOrigin(env.NYX_OAUTH_ISSUER)), 'TRUSTED_HTTPS_OAUTH_ISSUER_REQUIRED');
  check(Boolean(current) && env.NYX_OAUTH_AUDIENCE === current + '/mcp',
    'SEPARATE_MCP_AUDIENCE_REQUIRED');
  const scopes = String(env.NYX_OAUTH_SCOPES || '').split(',').map(x => x.trim()).sort();
  check(scopes.join(',') === ['nyx.read','nyx.write'].sort().join(','),
    'EXACT_MCP_SCOPES_REQUIRED');
  check((env.NYX_OAUTH_ALGORITHMS || 'RS256') === 'RS256',
    'ASYMMETRIC_RSA256_JWT_REQUIRED');

  check(postgresUrl(env.DATABASE_URL), 'DEDICATED_POSTGRES_REQUIRED');
  // A valid Postgres URL is not sufficient: require the host to match the
  // independently inventoried EMPTY Neon public project, NOT private Dev/Pro.
  // Only hostnames are compared; usernames/passwords are never emitted.
  let matchesNeon = false;
  try {
    const url = new URL(String(env.DATABASE_URL || ''));
    const expected = String(env.NYX_PUBLIC_NEON_HOST || '').trim().toLowerCase();
    const direct = expected;
    const pooled = expected.replace(/^([^.]+)(\.)/, '$1-pooler$2');
    const secure = ['require','verify-ca','verify-full'].includes(url.searchParams.get('sslmode') || '');
    matchesNeon = /^ep-[a-z0-9-]+\.[a-z0-9-]+\.eu-central-1\.aws\.neon\.tech$/.test(expected) &&
      (url.hostname.toLowerCase() === direct || url.hostname.toLowerCase() === pooled) &&
      url.pathname === '/neondb' && secure;
  } catch { /* Missing or malformed URL: block without revealing it. */ }
  check(matchesNeon, 'DEDICATED_PUBLIC_NEON_HOST_TLS_REQUIRED');
  check(aes32(env.NYX_STORAGE_ENCRYPTION_KEY), 'DEDICATED_AES256_KEY_REQUIRED');

  const legacyVariables = Object.entries(env).some(([name,value]) =>
    Boolean(typeof value === 'string' && value.trim()) &&
    (name === 'RCLONE_CONFIG' || name.startsWith('RCLONE_CONFIG_') ||
      name === 'NYX_SHARED_ROOTS_JSON' || name === 'NYX_PRIVATE_OAUTH_SUBJECTS' ||
      name === 'NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT' ||
      name === 'NYX_PRIVATE_LEGACY_OWNER_GOOGLE_EMAIL' ||
      name === 'NYX_PRIVATE_OWNER_GOOGLE_CLIENT_SECRET' ||
      name === 'NYX_PRIVATE_BROKER_GOOGLE_SUBJECT' ||
      name === 'NYX_PRIVATE_BROKER_SHARED_KEY_B64'));
  check(!legacyVariables, 'PRIVATE_OPERATOR_CREDENTIALS_OR_ALLOWLIST_FORBIDDEN');

  const privateFeatureFlags = [
    'NYX_PRIVATE_OWNER_LINK_ENABLED',
    'NYX_PRIVATE_BROKER_CLIENT_ENABLED',
    'NYX_PRIVATE_BROKER_SERVER_ENABLED',
    'NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER',
  ];
  check(privateFeatureFlags.every(key => !env[key] || env[key] === 'false'),
    'PRIVATE_BROKER_MUST_REMAIN_OFF_DURING_TENANT_PILOT');

  const exists = options.exists || fs.existsSync;
  const filePaths = ['/tmp/rclone.conf'];
  if (env.HOME) filePaths.push(path.join(env.HOME, '.config/rclone/rclone.conf'));
  if (env.RCLONE_CONFIG_PATH) filePaths.push(env.RCLONE_CONFIG_PATH);
  if (env.RCLONE_CONFIG) filePaths.push(env.RCLONE_CONFIG);
  check(filePaths.every(file => !exists(file)), 'PRIVATE_RCLONE_FILE_PRESENT');

  return {
    schema: 'nyx.public-storage-activation-preflight.v2',
    providerMode: megaOnly === googleMulti ? 'invalid' : megaOnly ? 'mega-only' : 'mega-and-google-drive',
    status: blockers.length ? 'BLOCKED' : 'CONFIG_PREPARED_LIVE_TESTS_REQUIRED',
    blockers,
    noSecretValuesReturned: true,
    liveDeploymentVerified: false,
    externalIdentityProviderVerified: false,
    separateDatabaseVerified: false,
    realTwoGoogleUsersAndMegaAccountsVerified: false,
    ownerPrivateBrokerVerified: false,
    nextRequiredEvidence: [
      'AUTH0_GOOGLE_CONNECTION_AND_GOOGLE_LOGIN_ENABLED_FOR_PUBLIC_CLIENT',
      'HOSTING_BUDGET_AND_DISTINCT_APP_DATABASE_CONFIRMED',
      'DEPLOYED_TESTER_COMMIT_AND_TOOL_DISCOVERY_VERIFIED',
      'TWO_REAL_GOOGLE_SIGNINS_AND_INDEPENDENT_PROVIDER_ENROLLMENTS',
      'CROSS_TENANT_DENIAL_AND_RESTART_PERSISTENCE',
      'SEPARATE_OWNER_EMAIL_TO_GOOGLE_SUB_LINK_AND_READ_ONLY_BROKER',
    ],
  };
}

if (require.main === module) {
  // The old tracked Heroku profile points to Dev and MUST NOT be used as
  // the private reference when Dev is repurposed as public.
  const oldPrivateOrigin = process.env.NYX_PRIVATE_PRO_URL || '';
  const report = publicMegaActivationPreflight(process.env, {
    existingPrivateOrigin: oldPrivateOrigin,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'CONFIG_PREPARED_LIVE_TESTS_REQUIRED') process.exitCode = 2;
}
