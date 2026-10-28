import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';
import type { GithubInstallationCredentials, GithubHttp } from './github-readonly';

/**
 * Deliberately bounded GitHub API writes: non-protected working branches, no
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
  private workingBranch(branch:string):void {
    if (typeof branch !== 'string' || branch.length > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
        branch.includes('..') || branch.includes('//') ||
        branch.endsWith('/') || branch.endsWith('.') || branch.startsWith('refs/') ||
        branch.split('/').some(p=>p.startsWith('.') || p.endsWith('.lock')) ||
        ['main','master'].includes(branch.toLowerCase()))
      throw new Error('GITHUB_PROTECTED_OR_INVALID_BRANCH');
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
       (suffix!=='' && !suffix.startsWith('/')) ||
       (suffix.includes('..') && !(method==='GET' &&
         /^\/compare\/(?:main|master)\.\.\.tester$/.test(suffix))) ||
       (/[?#]/.test(suffix) && !(method==='GET' &&
         (/^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(suffix) ||
          /^\/actions\/runs\?head_sha=[a-f0-9]{40}&per_page=10$/.test(suffix)))))
      throw new Error('GITHUB_API_PATH_INVALID');
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
  /** Create a working branch from the current default HEAD; never update that ref. */
  async createBranch(owner:string,id:string,repo:string,branch:string) {
    this.workingBranch(branch);
    const boundary={branch};
    const base=await this.defaultBranch(owner,id,repo,'contents:write',boundary);
    if(branch===base)throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
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
  /**
   * Create a review branch from an exact non-default, non-protected branch tip.
   * Never rewrites its source branch. Fail closed if staging moved since review.
   */
  async createFromNonDefault(owner:string,id:string,repo:string,branch:string,
    baseBranch:string,expectedBaseSha:string) {
    this.workingBranch(branch);
    this.workingBranch(baseBranch);
    if(!branch.startsWith('nyx/') || branch===baseBranch)
      throw new Error('GITHUB_REVIEW_BRANCH_REQUIRED');
    if(!/^[a-f0-9]{40}$/.test(expectedBaseSha))
      throw new Error('GITHUB_BASE_SHA_INVALID');
    const defaultRef=await this.defaultBranch(owner,id,repo,'contents:write',{branch});
    if(branch===defaultRef || baseBranch===defaultRef)
      throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
    const source=await this.call(owner,id,repo,'contents:write','GET',
      '/git/ref/heads/'+encodeURIComponent(baseBranch),undefined,{branch:baseBranch});
    const actualSha=source?.object?.sha;
    if(typeof actualSha!=='string'||!/^[a-f0-9]{40}$/.test(actualSha))
      throw new Error('GITHUB_BASE_SHA_INVALID');
    if(actualSha!==expectedBaseSha)throw new Error('GITHUB_STAGING_BASE_CHANGED');
    // Metadata only: enforce provider-reported non-protected source.
    const details=await this.call(owner,id,repo,'contents:write','GET',
      '/branches/'+encodeURIComponent(baseBranch),undefined,{branch:baseBranch});
    if(details?.name!==baseBranch || details?.protected!==false)
      throw new Error('GITHUB_SOURCE_PROTECTION_UNVERIFIED');
    const created=await this.call(owner,id,repo,'contents:write','POST','/git/refs',
      {ref:'refs/heads/'+branch,sha:actualSha},{branch});
    if(created?.ref!=='refs/heads/'+branch)
      throw new Error('GITHUB_BRANCH_RESPONSE_INVALID');
    return {repo,branch,from:baseBranch,baseSha:actualSha,created:true,
      defaultBranchUntouched:true};
  }

  /**
   * Prepare a DRAFT review into a verified non-default branch (e.g. tester).
   * No merge, workflow dispatch, deployment or default-branch changes.
   */
  async draftPullToNonDefault(owner:string,id:string,repo:string,branch:string,
    baseBranch:string,title:string,body='') {
    this.workingBranch(branch);
    this.workingBranch(baseBranch);
    if(!branch.startsWith('nyx/') || branch===baseBranch)
      throw new Error('GITHUB_REVIEW_BRANCH_REQUIRED');
    if(typeof title!=='string'||!title.trim()||title.length>200 ||
       typeof body!=='string'||body.length>10000)
      throw new Error('GITHUB_PULL_INPUT_INVALID');
    const defaultRef=await this.defaultBranch(owner,id,repo,'pulls:write',{branch});
    if(branch===defaultRef || baseBranch===defaultRef)
      throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
    const data=await this.call(owner,id,repo,'pulls:write','POST','/pulls',{
      head:branch,base:baseBranch,title:title.trim(),body,draft:true,
      maintainer_can_modify:false,
    },{branch});
    if(data?.draft!==true||!Number.isSafeInteger(data?.number)||
       data?.base?.ref!==baseBranch || data?.head?.ref!==branch)
      throw new Error('GITHUB_PULL_RESPONSE_INVALID');
    return {repo,number:data.number,url:data.html_url,branch,base:baseBranch,draft:true};
  }

  /**
   * Open a review-ready, non-draft PR ONLY between two verified unprotected
   * non-default branches. Exact SHA requirements prevent stale submissions.
   * Actual merges require a separate explicit CI-verified NYX tool call.
   */
  async openReviewedNonDefault(owner:string,id:string,repo:string,
    head:string,base:string,title:string,body:string,
    expectedHeadSha:string,expectedBaseSha:string) {
    this.workingBranch(head);this.workingBranch(base);
    if(!head.startsWith('nyx/') || head===base ||
       !/^[a-f0-9]{40}$/.test(expectedHeadSha) ||
       !/^[a-f0-9]{40}$/.test(expectedBaseSha) ||
       typeof title!=='string'||!title.trim()||title.length>200||
       typeof body!=='string'||body.length>10000)
      throw new Error('GITHUB_REVIEW_OPEN_INPUT_INVALID');
    const def=await this.defaultBranch(owner,id,repo,'pulls:write',{branch:head});
    if(head===def||base===def)
      throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
    const inspect=async(ref:string)=>{
      const result=await this.call(owner,id,repo,'resources:read','GET',
        '/branches/'+encodeURIComponent(ref),undefined,{branch:ref});
      if(result?.name!==ref||result?.protected!==false||
         !/^[a-f0-9]{40}$/.test(result?.commit?.sha))
        throw new Error('GITHUB_REVIEW_BRANCH_UNVERIFIED');
      return result.commit.sha as string;
    };
    if((await inspect(head))!==expectedHeadSha ||
       (await inspect(base))!==expectedBaseSha)
      throw new Error('GITHUB_REVIEW_BRANCH_CHANGED');
    const result=await this.call(owner,id,repo,'pulls:write','POST','/pulls',{
      head,base,title:title.trim(),body,draft:false,maintainer_can_modify:false,
    },{branch:head});
    if(result?.draft!==false||!Number.isSafeInteger(result.number) ||
       result?.head?.ref!==head||result?.base?.ref!==base ||
       result?.head?.sha!==expectedHeadSha||
       typeof result?.html_url!=='string')
      throw new Error('GITHUB_REVIEW_PR_RESPONSE_INVALID');
    return {repo,head,base,pr:result.number,url:result.html_url,
      readyForReview:true,merged:false,headSha:expectedHeadSha,
      baseSha:expectedBaseSha};
  }

  /**
   * Review-only release PR from the current non-default tester branch to a
   * GitHub-protected default (main/master). Never updates either ref.
   * The accepted source commit must be rechecked immediately before PR create.
   */
  async draftTesterRelease(owner:string,id:string,repo:string,
                           expectedTesterSha:string,title:string,body='') {
    const source='tester';
    if(!/^[a-f0-9]{40}$/.test(expectedTesterSha) ||
       typeof title!=='string'||!title.trim()||title.length>200 ||
       typeof body!=='string'||body.length>10000)
      throw new Error('GITHUB_RELEASE_INPUT_INVALID');
    const base=await this.defaultBranch(owner,id,repo,'pulls:write',{branch:source});
    if(!['main','master'].includes(base) || base===source)
      throw new Error('GITHUB_RELEASE_DEFAULT_BRANCH_UNSUPPORTED');
    const inspect=async(branch:string)=>{
      const item=await this.call(owner,id,repo,'resources:read','GET',
        '/branches/'+encodeURIComponent(branch),undefined,{branch:source});
      const sha=item?.commit?.sha;
      if(item?.name!==branch || typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha))
        throw new Error('GITHUB_RELEASE_BRANCH_UNVERIFIED');
      return {sha,protected:item.protected};
    };
    const dest=await inspect(base);
    if(dest.protected!==true)throw new Error('GITHUB_RELEASE_BASE_NOT_PROTECTED');
    const src=await inspect(source);
    if(src.protected!==false)throw new Error('GITHUB_RELEASE_SOURCE_PROTECTED');
    if(src.sha!==expectedTesterSha)throw new Error('GITHUB_RELEASE_SOURCE_CHANGED');
    const comparison=await this.call(owner,id,repo,'resources:read','GET',
      '/compare/'+encodeURIComponent(base)+'...'+encodeURIComponent(source),
      undefined,{branch:source});
    if(comparison?.status!=='ahead' || !Number.isSafeInteger(comparison.ahead_by) ||
       comparison.ahead_by<1 || comparison.behind_by!==0 ||
       !Array.isArray(comparison.files) || !comparison.files.length ||
       comparison.files.length>100)
      throw new Error('GITHUB_RELEASE_DIFF_UNVERIFIED');
    // Avoid duplicate open PRs; refuse when first page cannot prove uniqueness.
    const existing=await this.call(owner,id,repo,'pulls:read','GET','/pulls',
      undefined,{branch:source});
    if(!Array.isArray(existing) || existing.length>=30)
      throw new Error('GITHUB_RELEASE_PR_INVENTORY_INCOMPLETE');
    const current=existing.find(pr=>pr?.state==='open' &&
      pr?.head?.ref===source && pr?.base?.ref===base);
    if(current){
      if(!Number.isSafeInteger(current.number)||typeof current.html_url!=='string')
        throw new Error('GITHUB_RELEASE_PR_RESPONSE_INVALID');
      return {repo,number:current.number,url:current.html_url,branch:source,
        base,draft:current.draft===true,alreadyOpen:true,
        sourceSha:src.sha,changedFiles:comparison.files.length};
    }
    if((await inspect(source)).sha!==expectedTesterSha)
      throw new Error('GITHUB_RELEASE_SOURCE_CHANGED');
    const result=await this.call(owner,id,repo,'pulls:write','POST','/pulls',{
      head:source,base,title:title.trim(),body,draft:true,
      maintainer_can_modify:false,
    },{branch:source});
    if(!Number.isSafeInteger(result?.number)||result?.draft!==true||
       result?.head?.ref!==source||result?.base?.ref!==base ||
       result?.head?.sha!==expectedTesterSha ||
       typeof result?.html_url!=='string')
      throw new Error('GITHUB_RELEASE_PR_RESPONSE_INVALID');
    return {repo,number:result.number,url:result.html_url,branch:source,
      base,draft:true,alreadyOpen:false,sourceSha:expectedTesterSha,
      changedFiles:comparison.files.length};
  }

  /**
   * Stage an exact, reviewed Dev source snapshot on a *new* NYX review branch
   * forked from the verified current tester commit. No tester/master updates.
   * Read-only source GitHub installation and separate write-scoped destination
   * installation; never cross-copy secrets, binaries or workflow config.
   */
  async stageTesterFromDev(owner:string,sourceId:string,destinationId:string,
    sourceRepo:string,destinationRepo:string,sourceBranch:string,
    expectedSourceSha:string,expectedTesterSha:string,
    reviewBranch:string,paths:string[]) {
    this.repoName(sourceRepo);this.repoName(destinationRepo);
    if(!sourceRepo.endsWith('/YaRoute-Dev') ||
       !destinationRepo.endsWith('/YaRoute') ||
       sourceRepo===destinationRepo ||
       sourceRepo.split('/')[0].toLowerCase()===destinationRepo.split('/')[0].toLowerCase())
      throw new Error('GITHUB_TESTER_REPOSITORY_PAIR_INVALID');
    if(sourceBranch!=='main')this.workingBranch(sourceBranch);
    this.workingBranch(reviewBranch);
    if(sourceBranch!=='main' && !sourceBranch.startsWith('nyx/'))
      throw new Error('GITHUB_TESTER_SOURCE_BRANCH_FORBIDDEN');
    if(!reviewBranch.startsWith('nyx/') ||
       !/^[a-f0-9]{40}$/.test(expectedSourceSha) ||
       !/^[a-f0-9]{40}$/.test(expectedTesterSha) ||
       !Array.isArray(paths)||paths.length<1||paths.length>40||
       new Set(paths).size!==paths.length)
      throw new Error('GITHUB_TESTER_PROMOTION_INPUT_INVALID');
    for(const p of paths) {
      this.writablePath(p);
      if(!/^(src|tests|docs)\//.test(p))throw new Error('GITHUB_TESTER_PROMOTION_PATH_FORBIDDEN');
    }
    // Preflight BOTH accounts before GitHub creates any objects.
    const srcMeta=await this.call(owner,sourceId,sourceRepo,
      'resources:read','GET','',undefined,{branch:sourceBranch});
    if(srcMeta?.default_branch!=='main')
      throw new Error('GITHUB_TESTER_SOURCE_DEFAULT_UNEXPECTED');
    const dstMeta=await this.call(owner,destinationId,destinationRepo,
      'contents:write','GET','',undefined,{branch:reviewBranch});
    if(!['master','main'].includes(dstMeta?.default_branch))
      throw new Error('GITHUB_TESTER_DESTINATION_DEFAULT_UNEXPECTED');
    const srcRef=await this.call(owner,sourceId,sourceRepo,
      'resources:read','GET','/git/ref/heads/'+encodeURIComponent(sourceBranch),
      undefined,{branch:sourceBranch});
    const destRef=await this.call(owner,destinationId,destinationRepo,
      'contents:write','GET','/git/ref/heads/tester',
      undefined,{branch:reviewBranch});
    if(srcRef?.object?.sha!==expectedSourceSha ||
       destRef?.object?.sha!==expectedTesterSha)
      throw new Error('GITHUB_TESTER_PROMOTION_SHA_CHANGED');
    const destBranch=await this.call(owner,destinationId,destinationRepo,
      'contents:write','GET','/branches/tester',undefined,{branch:reviewBranch});
    if(destBranch?.name!=='tester' || destBranch?.protected!==false ||
       destBranch?.commit?.sha!==expectedTesterSha)
      throw new Error('GITHUB_TESTER_BRANCH_UNVERIFIED');
    const sourceCommit=await this.call(owner,sourceId,sourceRepo,'resources:read',
      'GET','/git/commits/'+expectedSourceSha,undefined,{branch:sourceBranch});
    const sourceTree=sourceCommit?.tree?.sha;
    if(typeof sourceTree!=='string' || !/^[a-f0-9]{40}$/.test(sourceTree))
      throw new Error('GITHUB_TESTER_SOURCE_TREE_UNVERIFIED');
    const tree=await this.call(owner,sourceId,sourceRepo,
      'resources:read','GET','/git/trees/'+sourceTree+'?recursive=1',
      undefined,{branch:sourceBranch});
    if(tree?.truncated!==false || !Array.isArray(tree.tree))
      throw new Error('GITHUB_TESTER_SOURCE_TREE_INCOMPLETE');
    const index=new Map<string,{sha:string;size:number}>();
    for(const f of tree.tree) {
      if(f?.type==='blob' && typeof f.path==='string' &&
         /^[a-f0-9]{40}$/.test(f.sha) &&
         Number.isSafeInteger(f.size) && f.size>=0) {
        index.set(f.path,{sha:f.sha,size:f.size});
      }
    }
    const files:{path:string;mode:'100644';type:'blob';content:string}[]=[];
    let total=0;
    for(const p of paths) {
      const e=index.get(p);
      if(!e || e.size>65536 || (total+=e.size)>768000)
        throw new Error('GITHUB_TESTER_SOURCE_FILE_LIMIT');
      // Enforce the owner's per-path source-read and destination-write grants.
      await this.registry.requireResource(owner,sourceId,'resources:read',
        {kind:'repository',id:sourceRepo,branch:sourceBranch,path:p});
      await this.registry.requireResource(owner,destinationId,'contents:write',
        {kind:'repository',id:destinationRepo,branch:reviewBranch,path:p});
      const blob=await this.call(owner,sourceId,sourceRepo,'resources:read',
        'GET','/git/blobs/'+e.sha,undefined,{branch:sourceBranch,path:p});
      if(blob?.encoding!=='base64'||typeof blob.content!=='string')
        throw new Error('GITHUB_TESTER_SOURCE_NOT_TEXT');
      const bytes=Buffer.from(blob.content.replace(/\s/g,''),'base64');
      if(bytes.length!==e.size||bytes.includes(0))
        throw new Error('GITHUB_TESTER_SOURCE_NOT_TEXT');
      const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      files.push({path:p,mode:'100644',type:'blob',content});
    }
    // Recheck both refs immediately before the first write. Fail closed on race.
    const latest=await this.call(owner,destinationId,destinationRepo,
      'contents:write','GET','/git/ref/heads/tester',
      undefined,{branch:reviewBranch});
    const latestSource=await this.call(owner,sourceId,sourceRepo,
      'resources:read','GET','/git/ref/heads/'+encodeURIComponent(sourceBranch),
      undefined,{branch:sourceBranch});
    if(latest?.object?.sha!==expectedTesterSha ||
       latestSource?.object?.sha!==expectedSourceSha)
      throw new Error('GITHUB_TESTER_PROMOTION_SHA_CHANGED');
    const targetCommit=await this.call(owner,destinationId,destinationRepo,
      'contents:write','GET','/git/commits/'+expectedTesterSha,
      undefined,{branch:reviewBranch});
    const baseTree=targetCommit?.tree?.sha;
    if(!/^[a-f0-9]{40}$/.test(baseTree))
      throw new Error('GITHUB_TESTER_BASE_TREE_UNVERIFIED');
    const built=await this.call(owner,destinationId,destinationRepo,
      'contents:write','POST','/git/trees',
      {base_tree:baseTree,tree:files},{branch:reviewBranch});
    if(!/^[a-f0-9]{40}$/.test(built?.sha))
      throw new Error('GITHUB_TESTER_TREE_RESPONSE_INVALID');
    const committed=await this.call(owner,destinationId,destinationRepo,
      'contents:write','POST','/git/commits',{
        message:'stage: reviewed Dev files for tester ('+expectedSourceSha.slice(0,12)+')',
        tree:built.sha,parents:[expectedTesterSha],
      },{branch:reviewBranch});
    if(!/^[a-f0-9]{40}$/.test(committed?.sha))
      throw new Error('GITHUB_TESTER_COMMIT_RESPONSE_INVALID');
    const created=await this.call(owner,destinationId,destinationRepo,
      'contents:write','POST','/git/refs',{
        ref:'refs/heads/'+reviewBranch,sha:committed.sha,
      },{branch:reviewBranch});
    if(created?.ref!=='refs/heads/'+reviewBranch)
      throw new Error('GITHUB_TESTER_BRANCH_RESPONSE_INVALID');
    return {repo:destinationRepo,branch:reviewBranch,base:'tester',
      sourceRepo,sourceSha:expectedSourceSha,testerSha:expectedTesterSha,
      reviewSha:committed.sha,fileCount:files.length,
      next:'nyx_connection_github_draft_pr_to_ref',merged:false};
  }

  /**
   * Explicit reviewed promotion ONLY to an unprotected non-default branch.
   * Require an exact head SHA, exact current base SHA, non-draft same-repository
   * PR, and successful GitHub Actions CI for that head. No admin bypass,
   * force-push, deployment dispatch or background auto-merge.
   */
  async mergeReviewedNonDefault(owner:string,id:string,repo:string,
    number:number,expectedHeadSha:string,expectedBaseSha:string) {
    if(!Number.isSafeInteger(number)||number<1||number>1000000||
       !/^[a-f0-9]{40}$/.test(expectedHeadSha)||
       !/^[a-f0-9]{40}$/.test(expectedBaseSha))
      throw new Error('GITHUB_REVIEW_MERGE_INPUT_INVALID');
    const pr=await this.call(owner,id,repo,'pulls:read','GET','/pulls/'+number);
    const head=pr?.head?.ref,base=pr?.base?.ref;
    this.workingBranch(head);this.workingBranch(base);
    if(!head.startsWith('nyx/') || head===base ||
       pr?.state!=='open' || pr?.draft!==false ||
       pr?.head?.sha!==expectedHeadSha ||
       pr?.base?.sha!==expectedBaseSha ||
       pr?.head?.repo?.full_name!==repo ||
       pr?.base?.repo?.full_name!==repo ||
       pr?.mergeable!==true)
      throw new Error('GITHUB_REVIEW_MERGE_UNVERIFIED');
    const meta=await this.call(owner,id,repo,'resources:read','GET','',
      undefined,{branch:base});
    if(meta?.default_branch===base)
      throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
    const branch=await this.call(owner,id,repo,'resources:read','GET',
      '/branches/'+encodeURIComponent(base),undefined,{branch:base});
    if(branch?.name!==base || branch?.protected!==false ||
       branch?.commit?.sha!==expectedBaseSha)
      throw new Error('GITHUB_REVIEW_BASE_CHANGED_OR_PROTECTED');
    const runs=await this.call(owner,id,repo,'ci:read','GET',
      '/actions/runs?head_sha='+expectedHeadSha+'&per_page=10',
      undefined,{branch:head});
    if(!Array.isArray(runs?.workflow_runs) ||
       runs.workflow_runs.length>=10 ||
       !runs.workflow_runs.some((run:any)=>
         run?.head_sha===expectedHeadSha &&
         run?.head_branch===head &&
         run?.name==='CI' && run?.status==='completed' &&
         run?.conclusion==='success') ||
       runs.workflow_runs.some((run:any)=>
         run?.head_sha===expectedHeadSha &&
         run?.head_branch===head &&
         ['queued','in_progress'].includes(run.status)))
      throw new Error('GITHUB_REVIEW_CI_UNVERIFIED');
    // One last server-side base ref and PR SHA check before the sole mutation.
    const again=await this.call(owner,id,repo,'pulls:read','GET',
      '/pulls/'+number,undefined,{branch:base});
    const latest=await this.call(owner,id,repo,'resources:read','GET',
      '/branches/'+encodeURIComponent(base),undefined,{branch:base});
    if(again?.state!=='open'||again?.draft!==false||
       again?.head?.sha!==expectedHeadSha||
       again?.base?.sha!==expectedBaseSha||
       latest?.commit?.sha!==expectedBaseSha||
       latest?.protected!==false)
      throw new Error('GITHUB_REVIEW_MERGE_STALE');
    const result=await this.call(owner,id,repo,'pulls:write','PUT',
      '/pulls/'+number+'/merge',
      {sha:expectedHeadSha,merge_method:'merge'},{branch:base});
    if(result?.merged!==true || !/^[a-f0-9]{40}$/.test(result.sha))
      throw new Error('GITHUB_REVIEW_MERGE_RESPONSE_INVALID');
    return {repo,pr:number,base,head,merged:true,mergeCommitSha:result.sha,
      production:false,sourceSha:expectedHeadSha};
  }

  /** Create/update exactly one text file with GitHub's optimistic SHA check. */
  async commitFile(owner:string,id:string,repo:string,branch:string,
    path:string,content:string,message:string,sha?:string) {
    this.workingBranch(branch);this.writablePath(path);
    if(typeof content!=='string' || Buffer.byteLength(content,'utf8')>65536 ||
       content.includes('\x00'))throw new Error('GITHUB_FILE_SIZE_OR_ENCODING_INVALID');
    if(typeof message!=='string'||!message.trim()||message.length>160)
      throw new Error('GITHUB_COMMIT_MESSAGE_INVALID');
    if(sha!==undefined && !/^[a-f0-9]{40}$/.test(sha))
      throw new Error('GITHUB_FILE_SHA_INVALID');
    // All default branches remain protected, even if not named main/master.
    const base=await this.defaultBranch(owner,id,repo,'contents:write',{branch});
    if(branch===base)throw new Error('GITHUB_DEFAULT_BRANCH_WRITE_FORBIDDEN');
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
    this.workingBranch(branch);
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
