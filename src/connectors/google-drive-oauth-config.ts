/** OAuth config and provider revocation helpers, no Nest module imports. */
export function googleCallbackUrl():string {
  const origin=process.env.NYX_PUBLIC_URL || '';
  const parsed=new URL(origin);
  if(parsed.protocol!=='https:' || parsed.username || parsed.password ||
     parsed.pathname!=='/' || parsed.search || parsed.hash) {
    throw new Error('GOOGLE_OAUTH_PUBLIC_URL_INVALID');
  }
  return parsed.origin+'/connect/google/callback';
}
export function googleOAuthConfiguration(){
  const clientId=process.env.NYX_GOOGLE_CLIENT_ID?.trim();
  const clientSecret=process.env.NYX_GOOGLE_CLIENT_SECRET?.trim();
  if(!clientId || !clientSecret || clientId.length>512 || clientSecret.length>512) {
    throw new Error('GOOGLE_OAUTH_NOT_CONFIGURED');
  }
  return {clientId,clientSecret};
}
function profileOf(remote:string,token:{
 access_token:string;refresh_token:string;token_type:string;expires_in:number;
},clientId:string,clientSecret:string){
  // Rclone expects a single config section; the exact JSON token format
  // is understood by its Google Drive backend and its OAuth refresh handler.
  const expiry=new Date(Date.now()+Math.min(token.expires_in,86400)*1000).toISOString();
  for(const item of [remote,clientId,clientSecret,token.access_token,token.refresh_token]){
    if(typeof item!=='string' || /[\r\n\0]/.test(item) || !item) {
      throw new Error('GOOGLE_OAUTH_RESPONSE_INVALID');
    }
  }
  return ['['+remote+']','type = drive','scope = drive.readonly',
    'client_id = '+clientId,'client_secret = '+clientSecret,
    'token = '+JSON.stringify({access_token:token.access_token,
      token_type:token.token_type,refresh_token:token.refresh_token,expiry}),
    ''].join('\n');
}

/** Revoke a Google OAuth token without logging or returning the token.
 * This is a best-effort external provider action; local vault deletion remains
 * authoritative for NestNyx access if Google is unavailable.
 */
export async function revokeGoogleDriveProfile(profile:string):Promise<boolean>{
  try{
    const match=profile.match(/^token\s*=\s*(\{[^\r\n]+\})\s*$/m);
    if(!match)return false;
    const token=JSON.parse(match[1]);
    const candidate=token.refresh_token;
    if(typeof candidate!=='string'||!candidate||candidate.length>8192)return false;
    const res=await fetch('https://oauth2.googleapis.com/revoke',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({token:candidate}).toString(),
    });
    return res.ok;
  }catch{return false;}
}
