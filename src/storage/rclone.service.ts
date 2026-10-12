import { Injectable, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

@Injectable()
export class RcloneService implements OnModuleInit {
  private readonly binary = process.env.RCLONE_BINARY || path.resolve('.bin/rclone');
  private readonly configPath = process.env.RCLONE_CONFIG_PATH || '/tmp/rclone.conf';

  onModuleInit() {
    // A process-wide rclone.conf contains one operator's storage credentials.
    // Never start a public multi-user service with that configuration.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') {
      throw new Error('PUBLIC_STORAGE_ISOLATION_NOT_IMPLEMENTED');
    }
    const encoded = process.env.RCLONE_CONFIG_B64;
    if (encoded) {
      fs.writeFileSync(this.configPath, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      fs.chmodSync(this.configPath, 0o600);
    }
    if (!fs.existsSync(this.configPath)) {
      throw new Error('No rclone config available. Set RCLONE_CONFIG_B64 or RCLONE_CONFIG_PATH.');
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.run(['version']);
    return stdout.split('\n')[0]?.trim() || 'unknown';
  }

  /**
   * Private-operator-only safe configuration summary.
   * Never return a configuration value other than a fixed, recognized scope;
   * never return token, secret, user ID, path or root identifier.
   * Declared scope is NOT a successful authorization or a write grant.
   */
  safeRemoteConfiguration(remote:string, type:'drive'|'mega') {
    const unavailable={inspection:'unavailable' as const,declaredScope:'unknown' as const,
      requestedAccess:'unknown' as const,sharedDriveConfigured:false,
      rootFolderConfigured:false,serviceAccountConfigured:false};
    if(process.env.NYX_DEPLOYMENT_MODE==='public')throw new Error('PRIVATE_RCLONE_CONNECTIONS_ONLY');
    if(!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote) ||
       (type!=='drive'&&type!=='mega'))throw new Error('RCLONE_REMOTE_INVALID');
    try{
      const stat=fs.statSync(this.configPath);
      if(!stat.isFile()||stat.size>512*1024)return unavailable;
      const raw=fs.readFileSync(this.configPath,'utf8');
      const values=new Map<string,string>();
      let inSection=false;
      for(const line of raw.split(/\r?\n/)){
        const section=line.match(/^\s*\[([^\]\r\n]+)\]\s*$/);
        if(section){inSection=section[1]===remote;continue;}
        if(!inSection||/^\s*[#;]/.test(line))continue;
        const option=line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if(option && ['type','scope','team_drive','root_folder_id','service_account_file',
                      'service_account_credentials'].includes(option[1].toLowerCase())){
          values.set(option[1].toLowerCase(),option[2]);
        }
      }
      if(values.get('type')!==type)return unavailable;
      const configuredScope=values.get('scope')?.trim().toLowerCase()??'';
      const scope = type==='drive' &&
        ['drive','drive.readonly','drive.file','drive.metadata.readonly'].includes(configuredScope)
        ? configuredScope as 'drive'|'drive.readonly'|'drive.file'|'drive.metadata.readonly'
        : 'unknown';
      return {inspection:'available' as const,declaredScope:scope,
        requestedAccess:scope==='drive.readonly'||scope==='drive.metadata.readonly'
          ? 'read-only-requested' as const
          : scope==='drive'||scope==='drive.file'
          ? 'write-capable-scope-requested-unverified' as const
          : 'unknown' as const,
        sharedDriveConfigured:type==='drive'&&Boolean(values.get('team_drive')?.trim()),
        rootFolderConfigured:type==='drive'&&Boolean(values.get('root_folder_id')?.trim()),
        serviceAccountConfigured:type==='drive'&&Boolean(
          values.get('service_account_file')?.trim()||values.get('service_account_credentials')?.trim()),
      };
    }catch{
      return unavailable;
    }
  }

  /**
   * Bounded read-only connectivity check. It lists at most the root directory
   * and discards all filenames, output, provider errors and credentials.
   * It NEVER tests, requests, or implies write access.
   */
  async probeRemoteRead(remote:string):Promise<'verified'|'failed'|'timeout'> {
    if(process.env.NYX_DEPLOYMENT_MODE==='public')
      throw new Error('PRIVATE_RCLONE_CONNECTIONS_ONLY');
    if(!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote))
      throw new Error('RCLONE_REMOTE_INVALID');
    return new Promise(resolve=>{
      let settled=false;
      let outputBytes=0;
      // Bound both runtime and output. Do not return stderr, even on failure.
      const child=spawn(this.binary,[
        '--config',this.configPath,'lsf',remote+':',
        '--max-depth','1','--format','p',
      ],{env:process.env,stdio:['ignore','pipe','pipe']});
      const finish=(status:'verified'|'failed'|'timeout')=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer=setTimeout(()=>{
        child.kill('SIGKILL');
        finish('timeout');
      },25000);
      // Allow runtime to wait for this bounded operation.
      const count=(chunk:Buffer|string)=>{
        outputBytes+=Buffer.byteLength(chunk);
        if(outputBytes>1024*1024){
          child.kill('SIGKILL');
          finish('failed');
        }
      };
      child.stdout.on('data',count);
      child.stderr.on('data',count);
      child.once('error',()=>finish('failed'));
      child.once('close',code=>finish(code===0?'verified':'failed'));
    });
  }

  async listRemoteNamesByType(type: string): Promise<string[]> {
    const { stdout } = await this.run(['listremotes', '--type', type, '--exact']);
    return stdout
      .split('\n')
      .map((line) => line.trim().replace(/:$/, ''))
      .filter(Boolean)
      .sort();
  }

  async listGoogleSharedDrives(remote: string): Promise<Array<{ id: string; name: string }>> {
    const raw = await this.json(['backend', 'drives', `${remote}:`]);
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const value = item as Record<string, unknown>;
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        return id && name ? { id, name } : null;
      })
      .filter((item): item is { id: string; name: string } => Boolean(item))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async json(args: string[]): Promise<unknown> {
    const { stdout } = await this.run(args);
    return JSON.parse(stdout);
  }

  async run(args: string[], maxOutputBytes?: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['--config', this.configPath, ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (maxOutputBytes && Buffer.byteLength(stdout) > maxOutputBytes) {
          child.kill();
          reject(new Error('rclone output exceeded configured limit'));
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`rclone exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }
}
