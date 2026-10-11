import { Injectable } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { RcloneCredentialVaultService } from '../storage/rclone-credential-vault.service';
import { assertSingleRcloneProfile } from '../storage/rclone-credential-vault.service';

@Injectable()
export class MegaSetupService {
  constructor(private readonly connections:ConnectorsService,
    private readonly vault:RcloneCredentialVaultService) {}

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
