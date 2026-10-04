import { Injectable, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

@Injectable()
export class RcloneService implements OnModuleInit {
  private readonly binary = process.env.RCLONE_BINARY || path.resolve('.bin/rclone');
  private readonly configPath = process.env.RCLONE_CONFIG_PATH || '/tmp/rclone.conf';

  onModuleInit() {
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

  async json(args: string[]): Promise<unknown> {
    const { stdout } = await this.run(args);
    return JSON.parse(stdout);
  }

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['--config', this.configPath, ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`rclone exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }
}
