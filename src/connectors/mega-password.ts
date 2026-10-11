import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * MEGA does not issue an API key for the Rclone backend. Rclone requires an
 * obscured account password. Obscuring is NOT encryption: the entire resulting
 * profile must be sealed in the owner-bound AES-GCM vault.
 */
export async function obscureMegaPassword(password:string):Promise<string>{
  if(typeof password!=='string' || password.length<1 || password.length>1024 ||
     /[\r\n\u0000]/.test(password)) throw new Error('MEGA_PASSWORD_INVALID');
  const binary=process.env.RCLONE_BINARY || path.resolve('.bin/rclone');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['obscure','-'],{
      env:{PATH:process.env.PATH,HOME:process.env.HOME},
      stdio:['pipe','pipe','pipe'],timeout:8000,
    });
    let result='',output=0,ended=false;
    const fail=()=>{if(!ended){ended=true;reject(new Error('MEGA_PASSWORD_OBSCURE_FAILED'));}};
    child.on('error',fail);
    child.stdout.on('data',(data:Buffer)=>{
      output+=data.length;
      if(output>1024){child.kill();return;}
      result+=data.toString('utf8');
    });
    // Do not collect subprocess errors; they may include sensitive provider data.
    child.stderr.on('data',()=>{});
    child.on('close',code=>{
      if(ended)return;ended=true;
      const obscured=result.trim();
      if(code!==0 || output>1024 || !/^[A-Za-z0-9_-]{16,1024}$/.test(obscured)){
        reject(new Error('MEGA_PASSWORD_OBSCURE_FAILED'));
      }else resolve(obscured);
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(password+'\n');
  });
}

export function megaProfile(remote:string,email:string,obscured:string):string {
  if(!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote) ||
     !/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email) ||
     email.length>254 || /[\r\n\u0000]/.test(email) ||
     !/^[A-Za-z0-9_-]{16,1024}$/.test(obscured)){
    throw new Error('MEGA_SETUP_INPUT_INVALID');
  }
  return ['['+remote+']','type = mega','user = '+email,'pass = '+obscured,''].join('\n');
}
