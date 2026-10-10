import { Injectable } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { ConnectorCapability } from './connector-registry';
import { ConnectorsService } from './connectors.service';

type GitHubInstallation = {
  id:number; app_id:number;
  account?:{login?:string; type?:string};
  permissions?:Record<string,string>;
  repository_selection?:string;
};
type GitHubRepositories = {total_count:number;repositories:Array<{full_name:string}>};

function githubAppConfig() {
  const appId=process.env.NYX_GITHUB_APP_ID;
  const key64=process.env.NYX_GITHUB_APP_PRIVATE_KEY_B64;
  if(!appId || !/^[1-9]\d{0,12}$/.test(appId) ||
     !key64 || !/^[A-Za-z0-9+/=\s]+$/.test(key64)) throw new Error('GITHUB_APP_NOT_CONFIGURED');
  const pem=Buffer.from(key64,'base64').toString('utf8');
  if(!pem.includes('-----BEGIN') || !pem.includes('PRIVATE KEY-----')) {
    throw new Error('GITHUB_APP_KEY_INVALID');
  }
  return {appId:Number(appId),pem};
}
function appJwt():string {
  const {appId,pem}=githubAppConfig();
  const now=Math.floor(Date.now()/1000);
  const input=[
    Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),
    Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:String(appId)})).toString('base64url'),
  ].join('.');
  const signer=createSign('RSA-SHA256');signer.update(input);signer.end();
  return input+'.'+signer.sign(pem).toString('base64url');
}
async function boundedJson(response:Response,limit=150000):Promise<any> {
  const raw=await response.text();
  if(!response.ok || raw.length>limit) throw new Error('GITHUB_API_UNAVAILABLE');
  try{return JSON.parse(raw);}catch{throw new Error('GITHUB_RESPONSE_INVALID');}
}
const jsonAccept={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function requestGitHub(path:string,method:'GET'|'POST',token:string,body?:unknown):Promise<any> {
  // Internal-only fixed host and known paths. Never expose path or method from MCP.
  if(!path.startsWith('/') || path.includes('..') || /[?#]/.test(path)) throw new Error('GITHUB_API_PATH_INVALID');
  const response=await fetch('https://api.github.com'+path,{
    method,
    headers:{...jsonAccept,Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,
    redirect:'error',
    signal:AbortSignal.timeout(10000),
  });
  return boundedJson(response);
}
function verifiedGrants(permissions:Record<string,string>):ConnectorCapability[] {
  const values=new Set<ConnectorCapability>(['repository:metadata']);
  if(['read','write'].includes(permissions.actions)) values.add('ci:read');
  if(['read','write'].includes(permissions.contents)) values.add('resources:read');
  if(['read','write'].includes(permissions.contents)) values.add('releases:read');
  if(['read','write'].includes(permissions.issues)) values.add('issues:read');
  if(['read','write'].includes(permissions.pull_requests)) values.add('pulls:read');
  // Writes deliberately never inferred, regardless of broad installation grant.
  return [...values];
}
const permissionsFor=(capability:ConnectorCapability):Record<string,'read'>=>{
  switch(capability) {
    case 'ci:read':return {metadata:'read',actions:'read'};
    case 'resources:read':return {metadata:'read',contents:'read'};
    case 'releases:read':return {metadata:'read',contents:'read'};
    case 'issues:read':return {metadata:'read',issues:'read'};
    case 'pulls:read':return {metadata:'read',pull_requests:'read'};
    case 'repository:metadata':return {metadata:'read'};
    default:throw new Error('GITHUB_OPERATION_NOT_ALLOWED');
  }
};

/**
 * Only signed installation identity and repo-bounded, read-only tokens.
 * No CLI, no user tokens at rest, no GitHub Actions dispatch, no write token.
 */
@Injectable()
export class GithubAppService {
  constructor(private readonly connections:ConnectorsService) {}

  async completeCallback(state:string,code:string) {
    if(!/^[a-zA-Z0-9_-]{8,255}$/.test(code)) throw new Error('GITHUB_OAUTH_CODE_INVALID');
    const pending=await this.connections.consumeGithubState(state); // one-time state
    const clientId=process.env.NYX_GITHUB_CLIENT_ID;
    const clientSecret=process.env.NYX_GITHUB_CLIENT_SECRET;
    const publicUrl=process.env.NYX_PUBLIC_URL;
    if(!clientId||!clientSecret||!publicUrl) throw new Error('GITHUB_OAUTH_NOT_CONFIGURED');
    const oauth=await fetch('https://github.com/login/oauth/access_token',{
      method:'POST',
      headers:{Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify({client_id:clientId,client_secret:clientSecret,code,
        redirect_uri:publicUrl.replace(/\/$/,'')+'/connect/github/callback'}),
      redirect:'error',signal:AbortSignal.timeout(10000),
    });
    const oauthData=await boundedJson(oauth,30000);
    const userToken=oauthData.access_token;
    if(typeof userToken!=='string'||userToken.length<12) throw new Error('GITHUB_OAUTH_EXCHANGE_FAILED');
    // GitHub App user access token confirms this user can access the installation.
    const accessible=await boundedJson(await fetch('https://api.github.com/user/installations?per_page=100',{
      method:'GET',headers:{...jsonAccept,Authorization:'Bearer '+userToken},
      redirect:'error',signal:AbortSignal.timeout(10000),
    }));
    if(!Number.isSafeInteger(accessible.total_count)||accessible.total_count>100 ||
      !Array.isArray(accessible.installations)) throw new Error('GITHUB_INSTALLATION_REVIEW_REQUIRED');
    const id=Number(pending.installationId);
    const matched=(accessible.installations as GitHubInstallation[]).find(i=>i.id===id);
    if(!matched||matched.app_id!==githubAppConfig().appId) throw new Error('GITHUB_INSTALLATION_NOT_OWNED');
    const verified=await requestGitHub('/app/installations/'+id,'GET',appJwt()) as GitHubInstallation;
    if(verified.id!==id||verified.app_id!==githubAppConfig().appId ||
      !verified.account?.login || verified.account.login!==matched.account?.login) {
      throw new Error('GITHUB_INSTALLATION_INVALID');
    }
    // Inspect provider authorization using metadata-only installation token.
    const token=await requestGitHub('/app/installations/'+id+'/access_tokens','POST',appJwt(),{
      permissions:{metadata:'read'},
    });
    if(typeof token.token!=='string') throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    const repos=await requestGitHub('/installation/repositories','GET',token.token) as GitHubRepositories;
    if(!Number.isSafeInteger(repos.total_count)||repos.total_count<1||repos.total_count>100||
      !Array.isArray(repos.repositories)||repos.repositories.length!==repos.total_count) {
      throw new Error('GITHUB_REPOSITORIES_REQUIRE_NARROW_INSTALLATION');
    }
    const names=repos.repositories.map(r=>r.full_name);
    if(names.some(x=>typeof x!=='string'||!/(^[\w.-]+\/[\w.-]+$)/.test(x))) throw new Error('GITHUB_REPOSITORIES_INVALID');
    return this.connections.activateGithub(pending.ownerId,pending.connectionId,
      String(id),verified.account.login,verifiedGrants(verified.permissions??{}),names);
  }

  /**
   * Every GitHub call mints a short-lived token restricted to one exact
   * user-selected repo AND one read permission. No token is persisted.
   */
  async tokenFor(ownerId:string,connectionId:string,installationId:string,
    repo:string,capability:ConnectorCapability,boundary?:{branch?:string;path?:string}):Promise<string> {
    const c=await this.connections.registryPolicy().requireResource(ownerId,connectionId,capability,{
      kind:'repository',id:repo,...boundary,
    });
    if(c.provider!=='github'||c.installationId!==installationId) throw new Error('GITHUB_INSTALLATION_MISMATCH');
    if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||repo.includes('..')) throw new Error('GITHUB_REPOSITORY_INVALID');
    if(!/^[1-9]\d{0,19}$/.test(installationId)) throw new Error('GITHUB_INSTALLATION_INVALID');
    const perms=permissionsFor(capability);
    const token=await requestGitHub('/app/installations/'+installationId+'/access_tokens',
      'POST',appJwt(),{
        repositories:[repo.split('/')[1]],
        permissions:perms,
      });
    if(typeof token.token!=='string'||token.token.length<15) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    return token.token;
  }
}
