/**
 * Stable, provider-attested identity. Never derive from display name, raw Rclone
 * token, refresh token, session, or client-provided claimed account name.
 * Keys are scoped by authenticated owner at the SQL unique index.
 */
export function verifiedStorageNamespace(
  provider:'google-drive'|'mega', accountId:string,
  driveId?:string | null,
):string {
  if(typeof accountId!=='string'||!accountId.length||accountId.length>256||
     /[\x00-\x1f\x7f]/.test(accountId))
    throw new Error('STORAGE_IDENTITY_INVALID');
  if(provider==='mega'){
    if(driveId!==undefined&&driveId!==null)throw new Error('STORAGE_NAMESPACE_INVALID');
    const normalized=accountId.trim().toLowerCase();
    if(!/^[a-z0-9.+_-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized))
      throw new Error('STORAGE_IDENTITY_INVALID');
    return 'mega-account:'+normalized;
  }
  if(provider==='google-drive'){
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(accountId))throw new Error('STORAGE_IDENTITY_INVALID');
    if(driveId===undefined||driveId===null||driveId==='') {
      // Each personal My Drive has one verified Google user subject.
      return 'my-drive:'+accountId;
    }
    // The Shared Drive ID identifies the actual Drive, even when multiple
    // accounts grant access or select different folders within it.
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(driveId))throw new Error('STORAGE_NAMESPACE_INVALID');
    return 'shared-drive:'+driveId;
  }
  throw new Error('STORAGE_PROVIDER_INVALID');
}
