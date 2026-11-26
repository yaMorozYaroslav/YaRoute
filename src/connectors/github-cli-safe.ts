import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectorsService } from './connectors.service';
import type { GithubAppService } from './github-app.service';

export type SafeCli = 'git' | 'gh';
type SafeRun = (executable:string,args:string[],env:Record<string,string>)=>Promise<string>;
const GH_VERSION='2.105.0';
const safeRepo=(repo:string)=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)&&!repo.includes('..');

/** No shell, arbitrary command string, user-controlled URL, extension or subcommand. */
export function safeCliPlan(tool:SafeCli,repo:string,token:string,home:string){
  if(!safeRepo(repo))throw Error('GITHUB_CLI_REPOSITORY_INVALID');
  if(typeof token!=='string'||token.length<15)throw Error('GITHUB_CLI_SCOPED_TOKEN_REQUIRED');
  const env:Record<string,string>={
    HOME:home, XDG_CONFIG_HOME:home, PATH:'/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'https',
    GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',
    GH_HOST:'github.com',GH_PAGER:'cat',NO_COLOR:'1',
  };
  if(tool==='git'){
    // Git's environment-only config avoids tokens in command line, remotes,
    // disk, Git config and log output. No extensions/hooks/submodules execute.
    env.GIT_CONFIG_COUNT='2';
    env.GIT_CONFIG_KEY_0='http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0='AUTHORIZATION: basic '+
      Buffer.from('x-access-token:'+token).toString('base64');
    env.GIT_CONFIG_KEY_1='credential.helper';
    env.GIT_CONFIG_VALUE_1='';
    return {tool,args:['ls-remote','--heads',
      'https://github.com/'+repo+'.git'],env};
  }
  if(tool==='gh'){
    env.GH_TOKEN=token;
    return {tool,args:['api','repos/'+repo,'--method','GET'],env};
  }
  throw Error('GITHUB_CLI_COMMAND_NOT_ALLOWED');
}

const runBounded:SafeRun=(binary,args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{
    env,stdio:['ignore','pipe','pipe'],shell:false,
    windowsHide:true,
  });
  let output='',bytes=0,done=false;
  const finish=(err?:Error)=>{
    if(done)return;
    done=true;clearTimeout(timeout);
    if(err)reject(err);else resolve(output);
  };
  const timeout=setTimeout(()=>{
    child.kill('SIGKILL');finish(Error('GITHUB_CLI_TIMEOUT'));
  },12000);
  child.stdout.on('data',(chunk:Buffer)=>{
    bytes+=chunk.length;
    if(bytes>128*1024){
      child.kill('SIGKILL');finish(Error('GITHUB_CLI_OUTPUT_LIMIT'));
    }else output+=chunk.toString('utf8');
  });
  // Never expose stderr: Git/gh can include private paths or provider text.
  child.stderr.on('data',()=>{});
  child.on('error',()=>finish(Error('GITHUB_CLI_EXECUTION_UNAVAILABLE')));
  child.on('close',code=>finish(code===0?undefined:Error('GITHUB_CLI_EXECUTION_FAILED')));
});

function binaryPath(tool:SafeCli){
  if(tool==='git'){
    for(const candidate of ['/usr/bin/git','/bin/git'])
      if(existsSync(candidate))return candidate;
    throw Error('GITHUB_GIT_BINARY_NOT_INSTALLED');
  }
  const binary=path.resolve('.bin/gh');
  const manifest=path.resolve('.bin/gh-manifest.json');
  if(!existsSync(binary)||!existsSync(manifest))
    throw Error('GITHUB_GH_PINNED_BINARY_NOT_INSTALLED');
  let metadata:unknown;
  try{metadata=JSON.parse(readFileSync(manifest,'utf8'));}catch{
    throw Error('GITHUB_GH_BINARY_UNVERIFIED');
  }
  const attestation=metadata as {version?:unknown;sha256?:unknown};
  if(attestation.version!==GH_VERSION||
     typeof attestation.sha256!=='string'||
     !/^[a-f0-9]{64}$/.test(attestation.sha256)||
     createHash('sha256').update(readFileSync(binary)).digest('hex')!==attestation.sha256)
    throw Error('GITHUB_GH_BINARY_UNVERIFIED');
  return binary;
}

/** Verified owner + one selected repository; no global PAT or user's host gh auth. */
export class SafeGithubCli {
  constructor(private readonly connections:ConnectorsService,
    private readonly githubApp:GithubAppService,
    private readonly runner:SafeRun=runBounded,
    private readonly resolveBinary:(t:SafeCli)=>string=binaryPath){}

  async probe(ownerId:string,connectionId:string,repo:string,tool:SafeCli){
    if(process.env.NYX_GITHUB_CLI_PILOT_ENABLED!=='true'||
       process.env.NYX_DEPLOYMENT_MODE!=='public'||
       process.env.NYX_PUBLIC_CONNECTORS_ENABLED!=='true')
      throw Error('GITHUB_CLI_PILOT_DISABLED');
    if(!safeRepo(repo)||!['git','gh'].includes(tool))
      throw Error('GITHUB_CLI_INPUT_INVALID');
    const owned=await this.connections.getOwned(ownerId,connectionId);
    if(owned.status!=='active'||owned.provider!=='github'||!owned.installationId)
      throw Error('GITHUB_CLI_CONNECTION_FORBIDDEN');
    // Both grants are proven by the authenticated user's actual GitHub App
    // connection, independently of caller-supplied connection ID/repo.
    const scope=tool==='git'?'resources:read':'repository:metadata';
    await this.connections.registryPolicy().requireResource(ownerId,connectionId,
      scope,{kind:'repository',id:repo});
    const executable=this.resolveBinary(tool);
    const token=await this.githubApp.tokenFor(ownerId,connectionId,owned.installationId,
      repo,scope);
    const home=await mkdtemp(path.join(os.tmpdir(),'nyx-safe-github-cli-'));
    try{
      const plan=safeCliPlan(tool,repo,token,home);
      const result=await this.runner(executable,plan.args,plan.env);
      if(tool==='git'){
        const heads=result.trim().split('\n').filter(Boolean);
        if(heads.length>5000||heads.some(x=>!/^[0-9a-f]{40}\trefs\/heads\/[^\r\n]{1,200}$/.test(x)))
          throw Error('GITHUB_CLI_RESPONSE_INVALID');
        return {status:'verified',tool,repository:repo,mode:'read-only',
          operation:'git ls-remote --heads',headCount:heads.length,
          sampleHeads:heads.slice(0,10).map(x=>x.split('\t')[1].replace('refs/heads/','')),
          restricted:true,tokenExposed:false,arbitraryExec:false};
      }
      if(result.length>128*1024)throw Error('GITHUB_CLI_RESPONSE_INVALID');
      let parsed:any;
      try{parsed=JSON.parse(result)}catch{throw Error('GITHUB_CLI_RESPONSE_INVALID')}
      if(parsed?.full_name!==repo||typeof parsed?.default_branch!=='string')
        throw Error('GITHUB_CLI_REPOSITORY_MISMATCH');
      return {status:'verified',tool,repository:repo,mode:'read-only',
        operation:'gh api repo metadata',defaultBranch:parsed.default_branch,
        restricted:true,tokenExposed:false,arbitraryExec:false};
    }finally{await rm(home,{recursive:true,force:true});}
  }
}
