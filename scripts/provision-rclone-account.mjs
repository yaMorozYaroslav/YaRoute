/**
 * Trusted server-side provisioning only. Pipe exactly one isolated Rclone
 * remote profile into stdin. Never pass provider credentials as argv, MCP
 * tool input, a GitHub file, a ChatGPT message or a logged environment value.
 *
 * Requires configured DATABASE_URL (existing Neon) and
 * NYX_RCLONE_CREDENTIAL_KEY, NYX_RCLONE_VAULT_ENABLED=true.
 * Example syntax (no secrets in arguments):
 *   node scripts/provision-rclone-account.mjs <oauth:subject> <connection-uuid> <google-drive|mega> <remote-name>
 * The remote must already have a pending/active owned connection row.
 */
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { RcloneCredentialVaultService }=require('../dist/storage/rclone-credential-vault.service.js');

const [owner,connectionId,provider,remote,...extra]=process.argv.slice(2);
if(extra.length||!owner||!connectionId||!['google-drive','mega'].includes(provider)||!remote||
   process.stdin.isTTY){
  process.stderr.write('USAGE: pipe one remote profile over stdin; provide owner, connection UUID, provider, remote name\n');
  process.exitCode=2;
}else{
  let profile='';
  try{
    for await(const chunk of process.stdin){
      profile+=chunk.toString('utf8');
      if(Buffer.byteLength(profile,'utf8')>32768)throw new Error('RCLONE_PROFILE_TOO_LARGE');
    }
    const vault=new RcloneCredentialVaultService();
    try{
      await vault.onModuleInit();
      const result=await vault.store(owner,connectionId,provider,remote,profile);
      process.stdout.write(JSON.stringify(result)+'\n');
    }finally{await vault.onModuleDestroy();}
  }catch(error){
    const errorCode=(error instanceof Error&&/^[A-Z][A-Z_]+$/.test(error.message))
      ?error.message:'RCLONE_CREDENTIAL_PROVISION_FAILED';
    process.stderr.write(errorCode+'\n');
    process.exitCode=1;
  }finally{
    profile='';
  }
}
