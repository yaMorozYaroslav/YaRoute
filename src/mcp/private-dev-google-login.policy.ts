/**
 * Optional hardening for the legacy PRIVATE DevNestNyx MCP endpoint.
 *
 * This function MUST receive claims from McpAuthService.verify(), which already
 * checks JWT signature, issuer, audience and requested MCP scopes. It does not
 * independently prove a Google email: an operator must confirm the Google
 * identity/provider-to-subject mapping out of band before configuring the sole
 * permitted subject. Never source either subject from request parameters.
 *
 * Public multi-user tenants must continue using isolated credentials; this
 * guard must not be used to expose legacy remotes in a public runtime.
 */
export interface SignedMcpSubject {
  sub?: unknown;
  iss?: unknown;
}

export interface PrivateDevGoogleOwnerConfig {
  NYX_DEPLOYMENT_MODE?: string;
  NYX_SERVICE_NAME?: string;
  NYX_OAUTH_ISSUER?: string;
  NYX_PRIVATE_OAUTH_SUBJECTS?: string;
  NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT?: string;
}

const GOOGLE_SOCIAL_SUBJECT = /^google-oauth2\|[A-Za-z0-9_-]{8,128}$/;

export function privateDevSingleGoogleOwnerAllowed(
  claims: SignedMcpSubject,
  config: PrivateDevGoogleOwnerConfig,
): boolean {
  if (!claims || !config ||
      config.NYX_DEPLOYMENT_MODE !== 'private' ||
      config.NYX_SERVICE_NAME !== 'DevNestNyx' ||
      typeof config.NYX_OAUTH_ISSUER !== 'string' ||
      !config.NYX_OAUTH_ISSUER.startsWith('https://') ||
      claims.iss !== config.NYX_OAUTH_ISSUER) return false;

  const raw = config.NYX_PRIVATE_OAUTH_SUBJECTS || '';
  const subjects = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (subjects.length !== 1 ||
      typeof config.NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT !== 'string') return false;
  const owner = config.NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT.trim();
  if (!GOOGLE_SOCIAL_SUBJECT.test(owner) ||
      subjects[0] !== owner ||
      claims.sub !== owner) return false;
  // Reject malformed comma-separated ACLs and hidden duplicate entries.
  if (raw.split(',').length !== 1 || raw.trim() !== owner) return false;
  return true;
}
