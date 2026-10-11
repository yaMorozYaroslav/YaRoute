import { Injectable } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { RcloneCredentialVaultService } from '../storage/rclone-credential-vault.service';
import { assertSingleRcloneProfile } from '../storage/rclone-credential-vault.service';
import { obscureMegaPassword, megaProfile } from './mega-obscure';

@Injectable()
export class MegaSetupService {
  constructor(private readonly connections:ConnectorsService,
    private readonly vault:RcloneCredentialVaultService) {}

  /** Password goes directly from browser to backend, never to MCP/ChatGPT. */
  async completeCredentials(state:string,email:string,password:string,mode:'read'|'manage') {
    if(process.env.NYX_MEGA_SELF_SERVICE_ENABLED!=='true' || !this.vault.isEnabled()){
      throw new Error('MEGA_SELF_SERVICE_DISABLED');
    }
    // Validate everything before consuming a single-use state or spawning Rclone.
    if(mode!=='read' && mode!=='manage')throw new Error('MEGA_PERMISSION_INVALID');
    if(typeof password!=='string' || password.length<1 || password.length>1024 ||
       /[\r\n\x00-\x1f\x7f]/.test(password))throw new Error('MEGA_PASSWORD_INVALID');
    megaProfile('validation_remote',email,'A'.repeat(32));
    // Do not pass passwords as command arguments or write them to disk.
    // Consume the verified one-use state before spawning a subprocess.
    // Invalid or replayed links must not be able to trigger Rclone work.
    const lease=await this.connections.consumeMegaSetupState(state);
    const obscure=await obscureMegaPassword(password);
    const profile=megaProfile(lease.remote,email,obscure);
    assertSingleRcloneProfile('mega',lease.remote,profile);
    await this.vault.store(lease.ownerId,lease.connectionId,'mega',lease.remote,profile);
    await this.connections.recordMegaAccessRequest(lease.ownerId,lease.connectionId,mode);
    // User approval never grants provider scopes or enables file writes.
    return {stored:true,verification:'unverified',requestedMode:mode,
      effectiveMode:'read-only-probe',connectionId:lease.connectionId};
  }

  async complete(state:string,profile:string) {
    if(process.env.NYX_MEGA_SELF_SERVICE_ENABLED!=='true' || !this.vault.isEnabled()){
      throw new Error('MEGA_SELF_SERVICE_DISABLED');
    }
    if(typeof profile!=='string' || profile.length>8192){
      throw new Error('MEGA_PROFILE_INVALID');
    }
    const lease=await this.connections.consumeMegaSetupState(state);
    assertSingleRcloneProfile('mega',lease.remote,profile);
    const permitted=new Set(['type','user','pass']);
    const options=[...profile.matchAll(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*=/gm)]
      .map(m=>m[1].toLowerCase());
    if(options.length!==3 || new Set(options).size!==3 ||
       options.some(x=>!permitted.has(x)) ||
       !/^\s*user\s*=\s*[^\s@=]+@[^\s@=]+\s*$/m.test(profile) ||
       !/^\s*pass\s*=\s*[A-Za-z0-9_\-+/=]{16,1024}\s*$/m.test(profile)){
      throw new Error('MEGA_PROFILE_INVALID');
    }
    await this.vault.store(lease.ownerId,lease.connectionId,'mega',lease.remote,profile);
    return {stored:true,verification:'unverified',connectionId:lease.connectionId};
  }
}
