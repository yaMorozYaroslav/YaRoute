import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';

/** Implementations must obtain short-lived installation tokens from a secure vault. */
export interface GithubInstallationCredentials {
  tokenFor(ownerId: string, connectionId: string, installationId: string, repo: string, capability: ConnectorCapability, boundary?: {branch?:string; path?:string}): Promise<string>;
}
export type GithubHttp = (url: string, init: RequestInit) => Promise<Response>;
export class GithubReadonlyConnector {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly credentials: GithubInstallationCredentials,
    private readonly http: GithubHttp = fetch,
  ) {}
  private async request(ownerId: string, connectionId: string, repo: string, suffix: string, capability: ConnectorCapability = 'ci:read', boundary?: {branch?:string; path?:string}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) throw new Error('GITHUB_REPOSITORY_INVALID');
    const connection = await this.registry.requireResource(ownerId, connectionId, capability, {kind: 'repository', id: repo, ...boundary});
    if (connection.provider !== 'github' || !connection.installationId) throw new Error('GITHUB_INSTALLATION_REQUIRED');
    const token = await this.credentials.tokenFor(ownerId, connectionId, connection.installationId, repo, capability, boundary);
    if (!token) throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE');
    const response = await this.http('https://api.github.com/repos/' + repo + suffix, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_API_FAILED');
    const body=await response.text();
    if(body.length>250000)throw new Error('GITHUB_RESPONSE_TOO_LARGE');
    try{return JSON.parse(body);}catch{throw new Error('GITHUB_RESPONSE_INVALID');}
  }
  /** Safe GitHub REST reads with explicit per-repo token scopes; no CLI. */
  async repository(ownerId:string,connectionId:string,repo:string) {
    const body=await this.request(ownerId,connectionId,repo,'','repository:metadata');
    return {fullName:body.full_name,private:body.private,
      defaultBranch:body.default_branch,archived:body.archived,description:body.description,
      htmlUrl:body.html_url,updatedAt:body.updated_at};
  }
  async issues(ownerId:string,connectionId:string,repo:string) {
    const body=await this.request(ownerId,connectionId,repo,'/issues?state=open&per_page=30','issues:read');
    if(!Array.isArray(body))throw new Error('GITHUB_RESPONSE_INVALID');
    return body.filter(x=>!x.pull_request).slice(0,30).map(x=>({
      number:x.number,title:x.title,state:x.state,url:x.html_url,
      updatedAt:x.updated_at,labels:Array.isArray(x.labels)?x.labels.slice(0,10).map((l:any)=>l.name):[],
    }));
  }
  async pullRequests(ownerId:string,connectionId:string,repo:string) {
    const body=await this.request(ownerId,connectionId,repo,'/pulls?state=open&per_page=30','pulls:read');
    if(!Array.isArray(body))throw new Error('GITHUB_RESPONSE_INVALID');
    return body.slice(0,30).map(x=>({
      number:x.number,title:x.title,state:x.state,draft:x.draft,url:x.html_url,
      base:x.base?.ref,head:x.head?.ref,updatedAt:x.updated_at,
    }));
  }
  async fileText(ownerId:string,connectionId:string,repo:string,path:string,ref:string) {
    if(!path||path.length>600||path.startsWith('/')||path.includes('\\')||
       path.split('/').some(x=>!x||x==='.'||x==='..')||/[?#\x00-\x1f]/.test(path)) {
       throw new Error('GITHUB_PATH_INVALID');
    }
    if(!ref||ref.length>120||!/^[A-Za-z0-9_./-]+$/.test(ref)||
       ref.includes('..')||ref.startsWith('-'))throw new Error('GITHUB_BRANCH_INVALID');
    const safePath=path.split('/').map(encodeURIComponent).join('/');
    const body=await this.request(ownerId,connectionId,repo,
      '/contents/'+safePath+'?ref='+encodeURIComponent(ref),'resources:read', {path,branch:ref});
    if(body.type!=='file'||typeof body.size!=='number'||body.size>65536||
       body.encoding!=='base64'||typeof body.content!=='string') {
       throw new Error('GITHUB_FILE_UNSUPPORTED_OR_TOO_LARGE');
    }
    const decoded=Buffer.from(body.content.replace(/\s/g,''),'base64');
    if(decoded.length>65536||decoded.includes(0))throw new Error('GITHUB_FILE_NOT_TEXT');
    return {path:body.path,sha:body.sha,size:decoded.length,text:decoded.toString('utf8')};
  }

  /** Read-only branch metadata. A branch-scoped rule cannot enumerate every branch. */
  async branches(ownerId:string,connectionId:string,repo:string) {
    const body=await this.request(ownerId,connectionId,repo,
      '/branches?per_page=30','resources:read');
    if(!Array.isArray(body))throw new Error('GITHUB_RESPONSE_INVALID');
    return body.slice(0,30).map(x=>({
      name:x.name,protected:x.protected,sha:x.commit?.sha,
    }));
  }

  async commits(ownerId:string,connectionId:string,repo:string,branch:string) {
    if(typeof branch!=='string'||!branch||branch.length>120||
      !/^[A-Za-z0-9_./-]+$/.test(branch)||branch.includes('..')||branch.startsWith('-')||
      branch.startsWith('/'))throw new Error('GITHUB_BRANCH_INVALID');
    const body=await this.request(ownerId,connectionId,repo,
      '/commits?per_page=25&sha='+encodeURIComponent(branch),
      'resources:read',{branch});
    if(!Array.isArray(body))throw new Error('GITHUB_RESPONSE_INVALID');
    return body.slice(0,25).map(x=>({
      sha:x.sha,summary:typeof x.commit?.message==='string'?
        x.commit.message.slice(0,300).split('\\n')[0]:undefined,
      date:x.commit?.committer?.date,url:x.html_url,
    }));
  }

  async releases(ownerId:string,connectionId:string,repo:string) {
    const body=await this.request(ownerId,connectionId,repo,
      '/releases?per_page=25','releases:read');
    if(!Array.isArray(body))throw new Error('GITHUB_RESPONSE_INVALID');
    return body.slice(0,25).map(x=>({
      id:x.id,name:typeof x.name==='string'?x.name.slice(0,160):undefined,
      tag:x.tag_name,draft:x.draft,prerelease:x.prerelease,
      publishedAt:x.published_at,url:x.html_url,
    }));
  }

  async workflows(ownerId: string, connectionId: string, repo: string) {
    return this.request(ownerId, connectionId, repo, '/actions/workflows?per_page=30');
  }
  async runs(ownerId: string, connectionId: string, repo: string, branch = 'master') {
    if (!/^[A-Za-z0-9_./-]{1,120}$/.test(branch) || branch.includes('..')) throw new Error('GITHUB_BRANCH_INVALID');
    return this.request(ownerId, connectionId, repo, '/actions/runs?per_page=30&branch=' + encodeURIComponent(branch),'ci:read',{branch});
  }
  async jobs(ownerId: string, connectionId: string, repo: string, runId: number) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('GITHUB_RUN_INVALID');
    return this.request(ownerId, connectionId, repo, '/actions/runs/' + runId + '/jobs?per_page=100');
  }
}
