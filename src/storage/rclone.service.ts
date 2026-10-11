import { Injectable, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

  /**
   * Run a bounded read-only provider probe with an exclusive temporary config.
   * No process-wide Rclone config, inherited NYX credentials, stdout or stderr
   * are returned to the caller. The config file is always removed afterwards.
   */
  async probeIsolated(remote:string,profile:string):Promise<boolean> {
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') throw new Error('PUBLIC_RCLONE_RUNTIME_DISABLED');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote) ||
        typeof profile !== 'string' || Buffer.byteLength(profile,'utf8')>32768) {
      throw new Error('RCLONE_PROFILE_INVALID');
    }
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-rclone-account-'));
    fs.chmodSync(dir,0o700);
    const config=path.join(dir,'config.conf');
    try {
      fs.writeFileSync(config,profile,{mode:0o600,flag:'wx'});
      fs.chmodSync(config,0o600);
      const env:NodeJS.ProcessEnv={};
      // Intentionally avoid provider credentials, NYX_* and RCLONE_* vars
      // from the shared server process. The config path is explicit.
      for(const k of ['PATH','HOME','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR',
        'HTTPS_PROXY','HTTP_PROXY','NO_PROXY']){
        if(process.env[k])env[k]=process.env[k];
      }
      return await new Promise<boolean>(resolve=>{
        let settled=false, output=0, exceeded=false;
        const finish=(ok:boolean)=>{
          if(settled)return;
          settled=true;resolve(ok);
        };
        const child=spawn(this.binary,
          ['--config',config,'about',remote+':','--json','--contimeout','5s','--timeout','12s'],
          {env,stdio:['ignore','pipe','pipe'],timeout:16000});
        for(const stream of [child.stdout,child.stderr]){
          stream.on('data',(chunk:Buffer)=>{
            output+=chunk.length;
            if(output>16384 && !exceeded){exceeded=true;child.kill();}
          });
        }
        child.on('error',()=>finish(false));
        child.on('close',code=>finish(code===0&&!exceeded));
      });
    } finally {
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.run(['version']);
    return stdout.split('\n')[0]?.trim() || 'unknown';
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
