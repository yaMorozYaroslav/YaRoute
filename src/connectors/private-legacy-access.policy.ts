/**
 * Private legacy Rclone eligibility policy for a future isolated broker.
 *
 * IMPORTANT: This pure function does NOT authenticate a request or a Google
 * account. Its arguments MUST be loaded by the trusted backend after verifying
 * the MCP access token (issuer, audience, signature) and Google's signed OIDC
 * identity token, then resolving the server-side account link. Never populate
 * these fields from MCP tool arguments, HTTP headers or a caller's email claim.
 *
 * Do not use this policy to load legacy credentials in a public tenant runtime.
 */
export interface AuthenticatedMcpIdentity {
  issuer: string;
  subject: string;
}
export interface VerifiedGoogleIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
}
export interface PrivateLegacyOwnerLink {
  mcpIssuer: string;
  mcpSubject: string;
  googleSubject: string;
  googleEmail: string;
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (s: string): string => s.trim().toLowerCase();

export function mayUsePrivateLegacyRclone(
  mcp: AuthenticatedMcpIdentity | null | undefined,
  google: VerifiedGoogleIdentity | null | undefined,
  configuredLinks: readonly PrivateLegacyOwnerLink[] | null | undefined,
): boolean {
  if (!mcp || !google || !Array.isArray(configuredLinks) ||
      configuredLinks.length < 1 || configuredLinks.length > 2) return false;
  if (typeof mcp.issuer !== 'string' || !mcp.issuer.startsWith('https://') ||
      typeof mcp.subject !== 'string' || !mcp.subject.trim()) return false;
  if (!GOOGLE_ISSUERS.has(google.issuer) ||
      typeof google.subject !== 'string' || !google.subject.trim() ||
      google.emailVerified !== true || typeof google.email !== 'string' ||
      !emailPattern.test(normalizeEmail(google.email))) return false;

  // Misconfigured, duplicate or ambiguous owner links fail closed.
  const seenMcp = new Set<string>();
  const seenGoogle = new Set<string>();
  for (const link of configuredLinks) {
    if (!link || typeof link.mcpIssuer !== 'string' ||
        !link.mcpIssuer.startsWith('https://') ||
        typeof link.mcpSubject !== 'string' || !link.mcpSubject.trim() ||
        typeof link.googleSubject !== 'string' || !link.googleSubject.trim() ||
        typeof link.googleEmail !== 'string' ||
        !emailPattern.test(normalizeEmail(link.googleEmail))) return false;
    const mcpKey = JSON.stringify([link.mcpIssuer, link.mcpSubject]);
    if (seenMcp.has(mcpKey) || seenGoogle.has(link.googleSubject)) return false;
    seenMcp.add(mcpKey);
    seenGoogle.add(link.googleSubject);
  }

  return configuredLinks.some(link =>
    link.mcpIssuer === mcp.issuer &&
    link.mcpSubject === mcp.subject &&
    link.googleSubject === google.subject &&
    normalizeEmail(link.googleEmail) === normalizeEmail(google.email));
}
