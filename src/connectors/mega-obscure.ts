import {spawn} from 'node:child_process';
import path from 'node:path';

/** Rclone's "obscure" is reversible. Vault encryption at rest is separate. */
export async function obscureMegaPassword(password:string):Promise<string> {
  if(typeof password!=='string' || password.length<1 || password.length>1024 ||
    /[\r\n\x00-\x1f\x7f]/.test(password)){
    throw new Error('MEGA_PASSWORD_INVALID');
  }
  const binary=process.env.RCLONE_BINARY || path.resolve('.bin/rclone');
  return new Promise<string>((resolve,reject)=>{
    let completed=false,stdout='',bytes=0,child;
    const fail=()=>{if(completed)return;completed=true;reject(new Error('MEGA_OBSCURE_FAILED'));};
    try{
      child=spawn(binary,['obscure','-'],{
        env:{PATH:process.env.PATH,HOME:process.env.HOME},
        stdio:['pipe','pipe','ignore'],timeout:8000,
      });
    }catch{fail();return;}
    const proc=child;
    proc.on('error',fail);
    proc.stdout.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>2048){proc.kill();return;}
      stdout+=chunk.toString('utf8');
    });
    proc.on('close',code=>{
      if(completed)return;
      const output=stdout.trim();
      if(code!==0 || bytes>2048 || !/^[A-Za-z0-9_+\/=\-]{16,2048}$/.test(output)){
        fail();return;
      }
      completed=true;resolve(output);
    });
    proc.stdin.on('error',()=>{});
    proc.stdin.end(password+'\n');
  });
}
export function megaProfile(remote:string,email:string,obscured:string):string {
  if(!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote) ||
     typeof email!=='string' || email.length>254 ||
     !/^[^@\s=<>\x00-\x1f]+@[^@\s=<>\x00-\x1f]+\.[^@\s=<>\x00-\x1f]+$/.test(email) ||
     !/^[A-Za-z0-9_+\/=\-]{16,2048}$/.test(obscured)){
    throw new Error('MEGA_SETUP_INPUT_INVALID');
  }
  return '['+remote+']\ntype = mega\nuser = '+email+'\npass = '+obscured+'\n';
}
