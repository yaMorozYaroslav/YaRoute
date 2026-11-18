import type { ConnectorCapability, ConnectorConnection, ConnectorResourceKind } from './connector-registry';

/**
 * A server-attested identity is an input from nyx_storage_verified_identity_v1,
 * not an OAuth claim, display name, remote name or other model-controlled field.
 * This module is pure: it NEVER performs a storage operation or grants access.
 */
export interface VerifiedStorageCandidate {
  connection: ConnectorConnection;
  verifiedOwnerId: string;
  verifiedProvider: 'google-drive' | 'mega';
  verifiedNamespace: string;
}

export interface StorageSelectionRequest {
  ownerId: string;
  provider: 'google-drive' | 'mega';
  verifiedNamespace: string;
  rootId: string;
  operation: ConnectorCapability;
  path?: string;
}

function containsPath(prefix: string | undefined, path: string | undefined): boolean {
  return !prefix || (path !== undefined && (path === prefix || path.startsWith(prefix + '/')));
}

function validPath(path: string | undefined): boolean {
  return path === undefined || (
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some(part => !part || part === '.' || part === '..')
  );
}

/**
 * Select the most capable ELIGIBLE connection within the same verified OAuth
 * owner, provider, namespace and root. A broader connection is never a reason
 * to override missing per-operation or provider-verified authorization.
 *
 * No eligible connection => fail closed. Multiple equally powerful connections
 * => stable connection ID tie-break, independent of database ordering.
 */
export function selectVerifiedStorageConnection(
  candidates: readonly VerifiedStorageCandidate[],
  request: StorageSelectionRequest,
): ConnectorConnection {
  if (!request.ownerId.startsWith('oauth:') ||
      !['mega', 'google-drive'].includes(request.provider) ||
      !request.verifiedNamespace || !request.rootId ||
      !request.operation.startsWith('storage:') ||
      !validPath(request.path)) {
    throw new Error('STORAGE_SELECTION_INVALID');
  }
  const kind: ConnectorResourceKind = request.provider === 'mega' ? 'mega-root' : 'drive';
  const eligible = candidates.filter(({connection: c, verifiedOwnerId, verifiedProvider, verifiedNamespace}) =>
    verifiedOwnerId === request.ownerId && c.ownerId === request.ownerId &&
    verifiedProvider === request.provider && c.provider === request.provider &&
    verifiedNamespace === request.verifiedNamespace &&
    c.status === 'active' &&
    c.capabilities.includes(request.operation) &&
    c.providerCapabilities.includes(request.operation) &&
    (c.resources ?? []).some(rule =>
      rule.kind === kind &&
      rule.id === request.rootId &&
      rule.capabilities.includes(request.operation) &&
      containsPath(rule.pathPrefix, request.path)
    )
  );

  if (!eligible.length) throw new Error('STORAGE_SELECTION_NO_AUTHORIZED_CONNECTION');

  // Score only the provider-verified, user-selected capabilities for the EXACT
  // resource. Never count requested-but-unverified permissions.
  function effectiveScore(c: ConnectorConnection) {
    const providerGrants = new Set(c.providerCapabilities);
    const selected = new Set(c.capabilities);
    const resourceGrants = new Set((c.resources ?? [])
      .filter(rule => rule.kind === kind && rule.id === request.rootId &&
        containsPath(rule.pathPrefix, request.path))
      .flatMap(rule => rule.capabilities));
    return [...selected].filter(cap =>
      cap.startsWith('storage:') && providerGrants.has(cap) && resourceGrants.has(cap)
    ).length;
  }
  eligible.sort((a,b) =>
    effectiveScore(b.connection) - effectiveScore(a.connection) ||
    a.connection.id.localeCompare(b.connection.id));
  return eligible[0].connection;
}
