import type { TenantRcloneProfile } from './tenant-rclone.service';

type GoogleProfile=Extract<TenantRcloneProfile,{provider:'google-drive'}>;
type VerifiedGoogleIdentity={accountId:string;driveId:string|null};
const validId=(x:unknown):x is string=>
  typeof x==='string' && /^[A-Za-z0-9_-]{1,256}$/.test(x);

/**
 * Never trust manifest identity assertions or use an unauthenticated email
 * label for deduplication. Read provider identity using ONLY the token from a
 * successful, isolated Rclone read, against fixed Google Drive API endpoints.
 * No caller-provided URL or provider hostname is accepted.
 */
export async function verifyImportedGoogleIdentity(
  profile:GoogleProfile, client:typeof fetch=fetch,
):Promise<VerifiedGoogleIdentity> {
  let token:unknown;
  try{token=JSON.parse(profile.token);}catch{
    throw new Error('TENANT_IMPORT_GOOGLE_TOKEN_INVALID');
  }
  const access=(token as {access_token?:unknown})?.access_token;
  if(typeof access!=='string'||access.length<8||access.length>8192||
     /[\x00-\x1f\x7f]/.test(access))
    throw new Error('TENANT_IMPORT_GOOGLE_TOKEN_INVALID');
  const read=async(url:string):Promise<Record<string,unknown>>=>{
    let response:Response;
    try{
      response=await client(url,{method:'GET',
        headers:{Authorization:'Bearer '+access,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.timeout(12000)});
    }catch{throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_UNAVAILABLE');}
    if(!response.ok)throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_UNAVAILABLE');
    let body:string;
    try{body=await response.text();}catch{
      throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_UNAVAILABLE');
    }
    if(body.length>16384)throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_OVERSIZE');
    let parsed:unknown;
    try{parsed=JSON.parse(body);}catch{
      throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_INVALID');
    }
    if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')
      throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_INVALID');
    return parsed as Record<string,unknown>;
  };
  const about=await read('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');
  const user=about.user as {permissionId?:unknown}|undefined;
  if(!validId(user?.permissionId))
    throw new Error('TENANT_IMPORT_GOOGLE_IDENTITY_INVALID');
  const accountId=user.permissionId;
  let driveId:string|null=null;
  // A selected shared drive must be proven with Google, not trusted solely
  // from an editable local Rclone option.
  if(profile.teamDriveId!==undefined){
    if(!validId(profile.teamDriveId))
      throw new Error('TENANT_IMPORT_GOOGLE_SHARED_DRIVE_INVALID');
    const shared=await read(
      'https://www.googleapis.com/drive/v3/drives/'+encodeURIComponent(profile.teamDriveId)+
      '?fields=id');
    if(shared.id!==profile.teamDriveId)
      throw new Error('TENANT_IMPORT_GOOGLE_SHARED_DRIVE_INVALID');
    driveId=profile.teamDriveId;
  }
  // Selected folder can be in a Shared Drive even when local team_drive was
  // omitted. Resolve the physical namespace before deduplication.
  if(!profile.accountRoot){
    if(!validId(profile.rootFolderId))
      throw new Error('TENANT_IMPORT_GOOGLE_ROOT_INVALID');
    const folder=await read(
      'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(profile.rootFolderId)+
      '?fields=id%2CdriveId%2CmimeType%2Ctrashed&supportsAllDrives=true');
    if(folder.id!==profile.rootFolderId && profile.rootFolderId!=='root')
      throw new Error('TENANT_IMPORT_GOOGLE_ROOT_INVALID');
    if(folder.trashed===true ||
       folder.mimeType!=='application/vnd.google-apps.folder' ||
       (folder.driveId!==undefined && !validId(folder.driveId)))
      throw new Error('TENANT_IMPORT_GOOGLE_ROOT_INVALID');
    const folderDrive=typeof folder.driveId==='string'?folder.driveId:null;
    if(driveId && folderDrive!==driveId)
      throw new Error('TENANT_IMPORT_GOOGLE_ROOT_SHARED_DRIVE_MISMATCH');
    if(folderDrive)driveId=folderDrive;
  }
  return {accountId,driveId};
}
