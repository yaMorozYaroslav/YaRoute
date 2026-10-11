import { Injectable } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { RcloneCredentialVaultService } from '../storage/rclone-credential-vault.service';
import { googleCallbackUrl, googleOAuthConfiguration } from './google-drive-oauth-config';

/**
 * Callback consumes an owner-bound, single-use state from Neon.
 * It is NEVER an input to a model-facing credential exchange tool.
 */
@Injectable()
export class GoogleDriveOAuthService {
  constructor(private readonly connections:ConnectorsService,
    private readonly vault:RcloneCredentialVaultService) {}

  async complete(state:string,code:string){
    if(!this.vault.isEnabled())throw new Error('RCLONE_VAULT_NOT_CONFIGURED');
    if(typeof code!=='string'||code.length<2||code.length>4096||
       !/^[A-Za-z0-9_./-]+$/.test(code))throw new Error('GOOGLE_OAUTH_CODE_INVALID');
    const lease=await this.connections.consumeGoogleDriveState(state);
    const {clientId,clientSecret}=googleOAuthConfiguration();
    const response=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:clientId,client_secret:clientSecret,code,
        code_verifier:lease.verifier,grant_type:'authorization_code',
        redirect_uri:googleCallbackUrl(),
      }).toString(),
      redirect:'error',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)throw new Error('GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED');
    const raw=await response.text();
    if(raw.length>16384)throw new Error('GOOGLE_OAUTH_RESPONSE_INVALID');
    const token=JSON.parse(raw) as Record<string,unknown>;
    if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'||
       token.token_type!=='Bearer'||!Number.isInteger(token.expires_in)||
       (token.expires_in as number)<1||(token.expires_in as number)>86400){
      throw new Error('GOOGLE_OAUTH_REFRESH_TOKEN_REQUIRED');
    }
    if(typeof token.scope==='string' &&
      !token.scope.split(/\s+/).includes('https://www.googleapis.com/auth/drive.readonly')) {
      throw new Error('GOOGLE_OAUTH_SCOPE_INVALID');
    }
    const profile=profileOf(lease.remote,token as {
      access_token:string;refresh_token:string;token_type:string;expires_in:number;
    },clientId,clientSecret);
    await this.vault.store(lease.ownerId,lease.connectionId,'google-drive',lease.remote,profile);
    await this.connections.activateGoogleDrive(lease.ownerId,lease.connectionId);
    return {connected:true,provider:'google-drive',scope:'drive.readonly'};
  }
}

