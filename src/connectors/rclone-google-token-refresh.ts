import type {TenantRcloneProfile} from './tenant-rclone.service';

type GoogleProfile=Extract<TenantRcloneProfile,{provider:'google-drive'}>;

/**
 * On an isolated successful Rclone operation, Rclone may write a refreshed
 * OAuth token into its private 0600 temp config. Only read [tenant].token,
 * never credential paths, remote names, or arbitrary INI sections.
 *
 * The returned token remains process-local and must be AES-GCM sealed before
 * any write to Neon. No plaintext, token fingerprint or token URL in logs.
 */
export function refreshedGoogleFromIsolatedConfig(
  profile:GoogleProfile,config:string,
):GoogleProfile|null {
  if(typeof config!=='string'||config.length>131072)
    throw new Error('TENANT_GOOGLE_REFRESH_CONFIG_INVALID');
  let section='',seen=0,candidate:string|undefined;
  for(const line of config.split(/\r?\n/)) {
    const header=line.match(/^\s*\[([^\]\r\n]+)\]\s*$/);
    if(header){section=header[1];continue;}
    if(section!=='tenant')continue;
    const token=line.match(/^token\s*=\s*(.+?)\s*$/);
    if(token){
      seen++;
      if(seen>1)throw new Error('TENANT_GOOGLE_REFRESH_DUPLICATE_TOKEN');
      candidate=token[1];
    }
  }
  if(!candidate)throw new Error('TENANT_GOOGLE_REFRESH_MISSING_TOKEN');
  let oldToken:unknown,newToken:unknown;
  try{
    oldToken=JSON.parse(profile.token);
    newToken=JSON.parse(candidate);
  }catch{throw new Error('TENANT_GOOGLE_REFRESH_INVALID_TOKEN');}
  const valid=(x:unknown):x is Record<string,unknown>=>
    !!x&&typeof x==='object'&&!Array.isArray(x);
  if(!valid(oldToken)||!valid(newToken)||
     typeof newToken.access_token!=='string'||
     newToken.access_token.length<8||newToken.access_token.length>8192||
     /[\x00-\x1f\x7f]/.test(newToken.access_token))
    throw new Error('TENANT_GOOGLE_REFRESH_INVALID_TOKEN');
  const oldRefresh=oldToken.refresh_token;
  const newRefresh=newToken.refresh_token;
  if(oldRefresh!==undefined&&(typeof oldRefresh!=='string'||oldRefresh.length>8192))
    throw new Error('TENANT_GOOGLE_REFRESH_INVALID_TOKEN');
  if(newRefresh!==undefined&&(typeof newRefresh!=='string'||newRefresh.length>8192))
    throw new Error('TENANT_GOOGLE_REFRESH_INVALID_TOKEN');
  const refresh=newRefresh||oldRefresh;
  if(typeof refresh!=='string'||refresh.length<8)
    throw new Error('TENANT_GOOGLE_REFRESH_MISSING_REFRESH_TOKEN');
  const updated={...newToken,refresh_token:refresh};
  const token=JSON.stringify(updated);
  if(token===profile.token)return null;
  return {...profile,token};
}
