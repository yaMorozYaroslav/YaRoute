import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';
import type { GithubInstallationCredentials, GithubHttp } from './github-readonly';

/**
 * Deliberately bounded GitHub API writes: only nyx/* staging branches, no
 * default-branch changes, no workflow/deployment/config edits and no merges.
 * Provider and per-owner grants are enforced BEFORE a scoped token is minted.
 */
export class GithubWriteConnector {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly credentials: GithubInstallationCredentials,
    private readonly http: GithubHttp = fetch,
  ) {}

  private repoName(repo:string):void {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..'))
      throw new Error('GITHUB_REPOSITORY_INVALID');
  }
  private stagingBranch(branch:string):void {
    if (typeof branch !== 'string' || branch.length > 100 ||
        !/^nyx\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
        branch.includes('..') || branch.includes('//') ||
        branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock'))
      throw new Error('GITHUB_STAGING_BRANCH_REQUIRED');
  }
  private writablePath(path:string):void {
    if (typeof path !== 'string' || !path || path.length > 400 ||
        path.startsWith('/') || path.includes('\\') ||
        /[?#\x00-\x1f]/.test(path) ||
        path.split('/').some(piece=>!piece || piece==='.' || piece==='..'))
      throw new Error('GITHUB_WRITE_PATH_INVALID');
    const lower=path.toLowerCase();
    const root=lower.split('/')[0];
    // Block all repo automation/hosting entrypoints, provider brokers and
    // checked-in credentials. Writes are still staged for human review.
    if (['.github','.git','scripts','broker','config'].includes(root) ||
        ['procfile','app.json','package.json','package-lock.json','.gitignore',
         '.npmrc','.gitmodules','dockerfile','heroku.yml'].includes(lower) ||
        /(^|\/)(\.env[^/]*|[^/]*\.(?:pem|key|p12|pfx|crt|cer|tf|tfvars))$/.test(lower) ||
        lower.startsWith('src/connectors/heroku-') ||
        lower.startsWith('src/connectors/heroku.'))
      throw new Error('GITHUB_INFRASTRUCTURE_WRITE_FORBIDDEN');
  }
  private async call(owner:string,id:string,repo:string,
    capability:ConnectorCapability,method:'GET'|'POST'|'PUT',suffix:string,
    body?:unknown,boundary?:{branch?:string;path?:string}) {
    this.repoName(repo);
    const conn=await this.registry.requireResource(owner,id,capability,
      {kind:'repository',id:repo,...boundary});
    if(conn.provider!=='github'||!conn.installationId) throw new Error('GITHUB_INSTALLATION_REQUIRED');
    const token=await this.credentials.tokenFor(owner,id,conn.installationId,repo,capability,boundary);
    if(!token)throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE');
    // Empty suffix is the safe GET repository-metadata endpoint only.
    if((suffix==='' && method!=='GET') ||
       (suffix!=='' && !suffix.startsWith('/')) || suffix.includes('..') ||
       /[?#]/.test(suffix)) throw new Error('GITHUB_API_PATH_INVALID');
    const response=await this.http('https://api.github.com/repos/'+repo+suffix,{
      method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      redirect:'error',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)throw new Error(response.status===409?'GITHUB_CONFLICT':'GITHUB_API_FAILED');
    const raw=await response.text();
    if(raw.length>100000)throw new Error('GITHUB_RESPONSE_TOO_LARGE');
    try{return JSON.parse(raw);}catch{throw new Error('GITHUB_RESPONSE_INVALID');}
  }
  private async defaultBranch(owner:string,id:string,repo:string,
    capability:ConnectorCapability,boundary?:{branch?:string}) {
    const data=await this.call(owner,id,repo,capability,'GET','',undefined,boundary);
    const ref=data?.default_branch;
    if(typeof ref!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(ref))
      throw new Error('GITHUB_DEFAULT_BRANCH_UNVERIFIED');
    return ref;
  }
  /** Create only a dedicated nyx/* review branch, using current default HEAD. */
  async createBranch(owner:string,id:string,repo:string,branch:string) {
    this.stagingBranch(branch);
    const boundary={branch};
    const base=await this.defaultBranch(owner,id,repo,'contents:write',boundary);
    const source=await this.call(owner,id,repo,'contents:write','GET',
      '/git/ref/heads/'+encodeURIComponent(base),undefined,boundary);
    const sha=source?.object?.sha;
    if(typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha))
      throw new Error('GITHUB_BASE_SHA_INVALID');
    const created=await this.call(owner,id,repo,'contents:write','POST','/git/refs',
      {ref:'refs/heads/'+branch,sha},boundary);
    if(created?.ref!=='refs/heads/'+branch)throw new Error('GITHUB_BRANCH_RESPONSE_INVALID');
    return {repo,branch,from:base,baseSha:sha,created:true};
  }
  /** Create/update exactly one text file with GitHub's optimistic SHA check. */
  async commitFile(owner:string,id:string,repo:string,branch:string,
    path:string,content:string,message:string,sha?:string) {
    this.stagingBranch(branch);this.writablePath(path);
    if(typeof content!=='string' || Buffer.byteLength(content,'utf8')>65536 ||
       content.includes('\x00'))throw new Error('GITHUB_FILE_SIZE_OR_ENCODING_INVALID');
    if(typeof message!=='string'||!message.trim()||message.length>160)
      throw new Error('GITHUB_COMMIT_MESSAGE_INVALID');
    if(sha!==undefined && !/^[a-f0-9]{40}$/.test(sha))
      throw new Error('GITHUB_FILE_SHA_INVALID');
    const suffix='/contents/'+path.split('/').map(encodeURIComponent).join('/');
    const result=await this.call(owner,id,repo,'contents:write','PUT',suffix,{
      message:message.trim(),content:Buffer.from(content,'utf8').toString('base64'),
      branch,...(sha?{sha}:{}),
    },{branch,path});
    const commitSha=result?.commit?.sha;
    if(typeof commitSha!=='string'||!/^[a-f0-9]{40}$/.test(commitSha))
      throw new Error('GITHUB_COMMIT_RESPONSE_INVALID');
    return {repo,branch,path,commitSha,mode:sha?'update':'create'};
  }
  /** Open a DRAFT pull request only, targeting the repository's default branch. */
  async draftPull(owner:string,id:string,repo:string,branch:string,
    title:string,body='') {
    this.stagingBranch(branch);
    if(typeof title!=='string'||!title.trim()||title.length>200 ||
       typeof body!=='string'||body.length>10000)
      throw new Error('GITHUB_PULL_INPUT_INVALID');
    const base=await this.defaultBranch(owner,id,repo,'pulls:write',{branch});
    if(branch===base)throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
    const data=await this.call(owner,id,repo,'pulls:write','POST','/pulls',{
      head:branch,base,title:title.trim(),body,draft:true,maintainer_can_modify:false,
    },{branch});
    if(data?.draft!==true||!Number.isSafeInteger(data?.number))
      throw new Error('GITHUB_PULL_RESPONSE_INVALID');
    return {repo,number:data.number,url:data.html_url,branch,base,draft:true};
  }
  async createIssue(owner:string,id:string,repo:string,title:string,body='') {
    if(typeof title!=='string'||!title.trim()||title.length>200 ||
       typeof body!=='string'||body.length>10000)
      throw new Error('GITHUB_ISSUE_INPUT_INVALID');
    const data=await this.call(owner,id,repo,'issues:write','POST','/issues',
      {title:title.trim(),body});
    if(!Number.isSafeInteger(data?.number)||data?.pull_request)
      throw new Error('GITHUB_ISSUE_RESPONSE_INVALID');
    return {repo,number:data.number,title:data.title,url:data.html_url};
  }
}
