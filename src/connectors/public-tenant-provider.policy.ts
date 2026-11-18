/**
 * Public tenants may enroll MEGA alone (legacy pilot) or MEGA plus Google
 * Drive (new opt-in). Both modes require Google OAuth sign-in. Separate
 * Google OIDC identity verification for the *private owner* is not a storage
 * provider enrollment.
 *
 * This rule must be enforced in the backend, not only in the Connections UI.
 * Legacy Rclone remotes stay in a separate private worker and never enter
 * this service or its per-tenant credential vault.
 */
export function publicTenantMegaOnly(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NYX_DEPLOYMENT_MODE === 'public' &&
    env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
    env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' &&
    env.NYX_PUBLIC_TENANT_MEGA_ONLY === 'true';
}

/**
 * New public flow, opt-in separately from the legacy MEGA-only rollout.
 * This extends *storage providers*, not the OAuth login providers:
 * every supported public storage operation still requires an issuer-signed
 * Google social-login subject.
 */
export function publicTenantGoogleMulti(
  env: Readonly<Record<string,string|undefined>> = process.env,
): boolean {
  return env.NYX_DEPLOYMENT_MODE === 'public' &&
    env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
    env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' &&
    env.NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED === 'true';
}

export function publicTenantGoogleLoginRequired(
  env: Readonly<Record<string,string|undefined>> = process.env,
): boolean {
  return publicTenantMegaOnly(env) || publicTenantGoogleMulti(env);
}

export function assertPublicTenantStorageProvider(
  provider: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  // Ambiguous deployment switches must fail closed instead of silently
  // falling back to allowing every provider.
  if (publicTenantMegaOnly(env) && publicTenantGoogleMulti(env)) {
    throw new Error('PUBLIC_TENANT_PROVIDER_MODE_CONFLICT');
  }
  if (publicTenantMegaOnly(env) && provider !== 'mega') {
    throw new Error('PUBLIC_TENANT_MEGA_ONLY');
  }
  if (publicTenantGoogleMulti(env) &&
      provider !== 'mega' && provider !== 'google-drive') {
    throw new Error('PUBLIC_TENANT_PROVIDER_NOT_ENABLED');
  }
}

/**
 * Public storage onboarding uses the existing OAuth login's signed JWT.
 * The trusted issuer must be configured to mint google-oauth2|<Google sub>
 * only following real Google OAuth authentication. This pattern is NOT a
 * substitute for signature/issuer/audience/scope verification in McpAuthService
 * or for separately verifying the operator's Google email before broker access.
 *
 * Enforce this at the MCP entrypoint and again at server-only enrollment /
 * tenant credential boundaries, so a previously issued non-Google sign-in
 * state cannot be redeemed after enabling either Google-login storage mode.
 */
export function assertPublicTenantGoogleSubject(
  subject: unknown,
  env: Readonly<Record<string,string|undefined>> = process.env,
): void {
  if (!publicTenantGoogleLoginRequired(env)) return;
  if (typeof subject !== 'string' ||
      !/^google-oauth2\|[0-9]{6,128}$/.test(subject)) {
    throw new Error('PUBLIC_GOOGLE_OAUTH_REQUIRED');
  }
}

export function assertPublicTenantGoogleOwnerId(
  ownerId: unknown,
  env: Readonly<Record<string,string|undefined>> = process.env,
): void {
  if (!publicTenantGoogleLoginRequired(env)) return;
  if (typeof ownerId !== 'string' || !ownerId.startsWith('oauth:')) {
    throw new Error('PUBLIC_GOOGLE_OAUTH_REQUIRED');
  }
  assertPublicTenantGoogleSubject(ownerId.slice('oauth:'.length),env);
}
