/**
 * A public NestNyx tenant may bring their own MEGA account, but may not
 * enroll independent Google Drive credentials when the operator has selected
 * the MEGA-only public rollout. Google OIDC *identity* verification for the
 * private owner is a different flow and remains available.
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

export function assertPublicTenantStorageProvider(
  provider: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (publicTenantMegaOnly(env) && provider !== 'mega') {
    throw new Error('PUBLIC_TENANT_MEGA_ONLY');
  }
}

/**
 * Public MEGA-only onboarding uses the existing OAuth login's signed JWT.
 * The trusted issuer must be configured to mint google-oauth2|<Google sub>
 * only following real Google OAuth authentication. This pattern is NOT a
 * substitute for signature/issuer/audience/scope verification in McpAuthService
 * or for separately verifying the operator's Google email before broker access.
 *
 * Enforce this at the MCP entrypoint and again at server-only enrollment /
 * tenant credential boundaries, so a previously issued non-Google sign-in
 * state cannot be redeemed after enabling MEGA-only Google-login mode.
 */
export function assertPublicTenantGoogleSubject(
  subject: unknown,
  env: Readonly<Record<string,string|undefined>> = process.env,
): void {
  if (!publicTenantMegaOnly(env)) return;
  if (typeof subject !== 'string' ||
      !/^google-oauth2\|[0-9]{6,128}$/.test(subject)) {
    throw new Error('PUBLIC_GOOGLE_OAUTH_REQUIRED');
  }
}

export function assertPublicTenantGoogleOwnerId(
  ownerId: unknown,
  env: Readonly<Record<string,string|undefined>> = process.env,
): void {
  if (!publicTenantMegaOnly(env)) return;
  if (typeof ownerId !== 'string' || !ownerId.startsWith('oauth:')) {
    throw new Error('PUBLIC_GOOGLE_OAUTH_REQUIRED');
  }
  assertPublicTenantGoogleSubject(ownerId.slice('oauth:'.length),env);
}
