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
