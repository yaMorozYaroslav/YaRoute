import { createHmac } from 'node:crypto';
import { privateBrokerKey } from './private-legacy-delegation';

export type ApprovedPrivateRemote = {
  name:string; provider:'google-drive'|'mega';
};
export const PRIVATE_REMOTE_ROOT = 'PRIVATE_ROOT';
const remoteName=/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;

/**
 * Stable virtual UUIDs are merely opaque UI handles; NEVER treated as bearer
 * grants. Every remote operation re-verifies the actual signed OAuth owner,
 * separately linked Google OIDC identity and private broker allowlist.
 */
export function privateRemoteView(
  ownerId:string, remote:ApprovedPrivateRemote, keyB64:string,
) {
  if(typeof ownerId!=='string'||!/^oauth:[^\x00-\x1f]{1,500}$/.test(ownerId) ||
     !remote || !remoteName.test(remote.name) ||
     !['google-drive','mega'].includes(remote.provider))
    throw new Error('PRIVATE_REMOTE_VIEW_INVALID');
  const hex=createHmac('sha256',privateBrokerKey(keyB64))
    .update('nyx-private-remotes-v1\0')
    .update(ownerId+'\0'+remote.provider+'\0'+remote.name).digest('hex');
  const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
  return {
    id, displayName:remote.name, provider:remote.provider,
    externalAccountId:'private-broker', capabilities:['storage:list'],
    // The broker's remote inventory is NOT proof of actual provider access.
    providerCapabilities:[], resources:[{kind:remote.provider==='mega'?'mega-root':'drive',
      id:PRIVATE_REMOTE_ROOT,capabilities:['storage:list']}],
    status:'pending' as const, availableCapabilities:['storage:list'],
    source:'private-pro-broker' as const,
    verification:'configured_not_live_verified' as const,
  };
}

/** Only ever select from a fresh PRIVATE-BROKER-signed owner inventory. */
export function findPrivateRemote(
  ownerId:string, connectionId:string, remotes:ApprovedPrivateRemote[],
  keyB64:string,
):ApprovedPrivateRemote|null {
  if(!Array.isArray(remotes)||remotes.length>20 ||
     new Set(remotes.map(r=>r.name)).size!==remotes.length)
    throw new Error('PRIVATE_REMOTE_INVENTORY_INVALID');
  const remote=remotes.find(r=>privateRemoteView(ownerId,r,keyB64).id===connectionId);
  return remote||null;
}
