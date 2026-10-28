import { AsyncLocalStorage } from 'node:async_hooks';
import { NyxCommandExecutor } from '../nyx/command-executor.service';
import { NyxBootstrapService } from '../nyx/bootstrap.service';
import { NyxCliRegistryService } from '../nyx/cli-registry.service';
import { NyxHeadLibraryService } from '../nyx/head-library.service';
import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { InitService } from '../init/init.service';
import { JobStoreService } from '../storage/job-store.service';
import { StorageService } from '../storage/storage.service';
import { CopyJobPayload } from '../storage/storage.types';
import { assessPotentialFinancialLoss } from '../connectors/financial-risk-preflight';
import { ConnectorsService } from '../connectors/connectors.service';
import { TenantRcloneService } from '../connectors/tenant-rclone.service';
import { TenantGoogleOAuthService } from '../connectors/tenant-google-oauth.service';
import { TenantMegaEnrollmentService } from '../connectors/tenant-mega-enrollment.service';
import { GithubReadonlyConnector } from '../connectors/github-readonly';
import { GithubWriteConnector } from '../connectors/github-writes';
import { githubInstallationUrl } from '../connectors/github-app.service';
import { CONNECTIONS_PANEL_URI, CONNECTIONS_PANEL_HTML, CONNECTIONS_PANEL_BRAND_ORIGIN } from '../connectors/connections-panel';
import type { ConnectorCapability, ConnectorResourceRule } from '../connectors/connector-registry';

@Injectable()
export class McpService {
  private readonly ownerContext = new AsyncLocalStorage<string>();
  private readonly logger = new Logger(McpService.name);
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    private readonly storage: StorageService,
    private readonly jobs: JobStoreService,
    private readonly init: InitService,
    private readonly commands: NyxCommandExecutor,
    private readonly bootstrap: NyxBootstrapService,
    private readonly cliRegistry: NyxCliRegistryService,
    private readonly headLibrary: NyxHeadLibraryService,
    private readonly connections: ConnectorsService,
    private readonly tenantRclone: TenantRcloneService,
    private readonly tenantGoogle: TenantGoogleOAuthService,
    private readonly tenantMega: TenantMegaEnrollmentService,
    private readonly github: GithubReadonlyConnector,
    private readonly githubWrites: GithubWriteConnector,
  ) {
    const handler = createMcpHandler(() => this.buildServer());
    this.nodeHandler = toNodeHandler(handler, {
      onerror: (error) => this.logger.error(`MCP transport error: ${error.message}`),
    });
  }

  async handle(req: Request, res: Response, parsedBody: unknown) {
    // Legacy MCP tools still resolve global storage roots and credentials.
    // Public mode must not expose them before per-user routing is complete.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED !== 'true') {
      res.status(503).json({ error: 'public_storage_migration_incomplete' });
      return;
    }
    await this.ownerContext.run(`oauth:${res.locals.nyxSubject}`, () => this.nodeHandler(req, res, parsedBody));
  }

  private buildServer() {
    const server = new McpServer({
      name: 'NestNyx',
      version: '0.8.2',
      icons: CONNECTIONS_PANEL_BRAND_ORIGIN ? [{src:CONNECTIONS_PANEL_BRAND_ORIGIN+'/branding/icon.png',mimeType:'image/png',sizes:['96x96']}] : [],
    });

    // Capability discovery is advisory: canonical Head/nyxcli.json defines semantics.
    // A supported tool failing authorization is NOT a GPT fallback condition.
    server.registerTool(
      'nyx_capabilities',
      {
        title: 'Discover NestNyx command capabilities',
        description: 'Read-only routing inventory. Resolve the command in canonical Head first; only unsupported commands may be handled by GPT. Errors are never treated as unsupported.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => this.safeTool(async () => ({
        schema: 'nyx.mcp.capabilities.v1',
        authority: 'canonical Head/LEAD/Core_Skills/YaRoCLI/nyxcli.json',
        routing: 'head_resolve_then_mcp_capability_then_mcp_or_gpt',
        unsupportedOnlyFallback: true,
        executionFailureFallback: false,
        commandEntrypoints: {
          execute: { tool: 'nyx_execute', commands: 'backend-resolved; not all Head commands guaranteed' },
          help: { tool: 'nyx_help', command: 'hel', mode: 'read-only' },
          ini: { tool: 'nyx_ini', status: 'registered' },
          sum: { tool: 'nyx_sum', status: 'registered' },
        },
        auxiliaryTools: process.env.NYX_DEPLOYMENT_MODE === 'public' ?
          ['nyx_connections_home','nyx_connections_panel','nyx_connections_list','nyx_risk_preview',
           ...(process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
               process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' ?
            ['nyx_storage_connections_list','nyx_storage_connection_create',
             'nyx_storage_connection_permissions','nyx_storage_connection_roots',
             'nyx_storage_connection_begin_google','nyx_storage_connection_begin_mega',
             'nyx_storage_connection_test_pending','nyx_storage_connection_activate',
             'nyx_storage_connection_test_active','nyx_storage_connection_list_files'] : [])] : ['nyx_mega_accounts', 'nyx_mega_list', 'nyx_mega_stat', 'nyx_mega_capacity', 'nyx_global_index', 'nyx_copy_file', 'nyx_risk_preview','nyx_connections_home','nyx_connections_panel','nyx_rclone_connections_list','nyx_head_status','nyx_areas','nyx_list','nyx_stat','nyx_capacity','nyx_job_status'],
        note: 'This inventory does not assert that a backend command is executable; use backend command resolution and verified receipts.',
      })),
    );

    server.registerTool(
      'nyx_risk_preview',
      {
        title: 'Preview potential financial and operational loss (no execution)',
        description: 'Read-only conservative risk preview. Warns about CI, deployments, transfers, growth, recurring jobs, outages, data loss, and forbidden financial actions. Input metadata is unverified and no billing details are accessed. This tool NEVER grants permission or executes an operation.',
        inputSchema: z.object({
          provider: z.enum(['github','gitlab','google-drive','mega','heroku','neon','other']),
          operation: z.string().min(1).max(80),
          paths: z.array(z.string().min(1).max(2048)).max(500).optional(),
          estimatedCalls: z.number().int().nonnegative().optional(),
          estimatedBytes: z.number().int().nonnegative().optional(),
          recurring: z.boolean().optional(),
          crossProvider: z.boolean().optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => this.safeTool(async () => ({
        ...assessPotentialFinancialLoss(input),
        sourceVerification: 'unverified_caller_preview',
        executed: false,
        message: 'This preview does not authorize or execute an operation. The executor must independently verify risk, provider restrictions, and release gates.',
      })),
    );

    // MCP Apps connection manager. It is an authenticated UI resource, NOT an
    // alternate backend API or a way to bypass per-user MCP authorization.
    server.registerResource(
      'NestNyx GitHub Connections', CONNECTIONS_PANEL_URI,
      {mimeType:'text/html;profile=mcp-app'},
      async () => ({contents:[{
        uri:CONNECTIONS_PANEL_URI, mimeType:'text/html;profile=mcp-app',
        text:CONNECTIONS_PANEL_HTML,
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:CONNECTIONS_PANEL_BRAND_ORIGIN ? [CONNECTIONS_PANEL_BRAND_ORIGIN] : []}},
          'openai/widgetCSP':{redirect_domains:[
            'https://github.com','https://accounts.google.com',
            ...(CONNECTIONS_PANEL_BRAND_ORIGIN ? [CONNECTIONS_PANEL_BRAND_ORIGIN] : []),
          ]},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
      }]}),
    );

    // Separate global and thread entrypoints make each launcher independently
    // discoverable. Both reuse the SAME authenticated, read-only view payload.
    // No storage, Head authority, provider grants or credential paths are changed.
    const connectionsPanelResult = async () => this.safeTool(async () => {
      const ownerId = this.connectorOwner();
      return {
        schema:'nyx.connections.panel.v1',
        ownerId,
        connections:await this.connections.list(ownerId),
        providers:[{id:'github',availability:'oauth_ready_if_configured'},
          ...(process.env.NYX_DEPLOYMENT_MODE === 'public' &&
              process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
              process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true'
            ? [{id:'mega',availability:'isolated_read_only_pilot'},
               {id:'google-drive',availability:'isolated_read_only_pilot'}] : [])],
        note:'GitHub authorization is required. Refresh ChatGPT plugin discovery after deployment.',
      };
    });

    server.registerTool('nyx_connections_panel',{
      title:'☁️ NestNyx Connections',
      description:process.env.NYX_DEPLOYMENT_MODE === 'public' && process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' ?
         'Open connections for GitHub and isolated user-owned MEGA/Google Drive read-only pilot. Credentials are entered only in first-party provider flows.' :
         'Open the private NestNyx GitHub connection manager. MEGA and Google Drive use the existing private storage backend.',
      inputSchema:z.object({}),
      _meta:{
        ui:{resourceUri:CONNECTIONS_PANEL_URI,visibility:['model','app']},
        'openai/ui':{entrypoints:[{type:'thread'}]},
        'openai/outputTemplate':CONNECTIONS_PANEL_URI,
      },
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },connectionsPanelResult);

    server.registerTool('nyx_connections_home',{
      title:'☁️ NestNyx',
      description:'Open authenticated NestNyx Connections from the sidebar. Isolated storage onboarding appears only in the separately deployed public tenant pilot; no credentials are entered in ChatGPT.',
      inputSchema:z.object({}),
      _meta:{
        ui:{resourceUri:CONNECTIONS_PANEL_URI,visibility:['model','app']},
        'openai/ui':{entrypoints:[{type:'global'}]},
        'openai/outputTemplate':CONNECTIONS_PANEL_URI,
      },
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },connectionsPanelResult);

    server.registerTool('nyx_connections_list',{
      title:'List my NestNyx connections',
      description:'Read owner-scoped connections and resource permissions without exposing secrets.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>({
      connections:await this.connections.list(this.connectorOwner()),
    })));

    server.registerTool('nyx_connection_create',{
      title:'Create a named connection',
      description:'Create a PENDING GitHub App connection. No provider access is granted until verified GitHub authorization.',
      inputSchema:z.object({provider:z.literal('github'),name:z.string().min(1).max(80)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },async ({provider,name})=>this.safeTool(()=>
      this.connections.create(this.connectorOwner(),provider,name)));

    server.registerTool('nyx_connection_rename',{
      title:'Rename my connection',
      description:'Change a display label without moving authorization or changing identity.',
      inputSchema:z.object({id:z.string().uuid(),name:z.string().min(1).max(80)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({id,name})=>this.safeTool(()=>
      this.connections.rename(this.connectorOwner(),id,name)));

    server.registerTool('nyx_connection_permissions',{
      title:'Select per-connection API permissions',
      description:'Set desired API capability permissions. Unverified provider permissions cannot become executable.',
      inputSchema:z.object({id:z.string().uuid(),capabilities:z.array(z.string().max(60)).max(40)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({id,capabilities})=>this.safeTool(()=>
      this.connections.permissions(this.connectorOwner(),id,capabilities as ConnectorCapability[])));

    server.registerTool('nyx_connection_resources',{
      title:'Select resources of my connection',
      description:'Allow selected repositories or applications. Provider authorization is independently enforced.',
      inputSchema:z.object({id:z.string().uuid(),resources:z.array(z.object({
        kind:z.literal('repository'),
        id:z.string().min(1).max(512),
        capabilities:z.array(z.string().max(60)).max(40),
        pathPrefix:z.string().max(2048).optional(),
        branches:z.array(z.string().max(120)).max(50).optional(),
      }).strict()).max(100)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({id,resources})=>this.safeTool(()=>
      this.connections.resources(this.connectorOwner(),id,resources as ConnectorResourceRule[])));

    server.registerTool('nyx_connection_disconnect',{
      title:'Disconnect one NestNyx account',
      description:'Revoke local connection permissions and selected resources. Provider App uninstall must be done by user in provider UI.',
      inputSchema:z.object({id:z.string().uuid()}),
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
    },async({id})=>this.safeTool(()=>
      this.connections.disconnect(this.connectorOwner(),id)));

    server.registerTool('nyx_connection_github_install_url',{
      title:'Get official NestNyx GitHub App install page',
      description:'Resolve the installed App registration from GitHub with a server-side App JWT. Returns only an official GitHub install URL; no credentials or grants.',
      inputSchema:z.object({id:z.string().uuid()}),
      _meta:{ui:{visibility:['app']}},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id})=>this.safeTool(async()=>{
      const connection=await this.connections.getOwned(this.connectorOwner(),id);
      if(connection.provider!=='github'||connection.status!=='pending')
        throw new Error('GITHUB_CONNECTION_NOT_PENDING');
      return githubInstallationUrl();
    }));

    server.registerTool('nyx_connection_begin_github',{
      title:'Authorize my GitHub App installation',
      description:'One-time, state-bound GitHub OAuth. Auto-discovers an eligible installed GitHub App under the authorized GitHub account; ambiguous installations fail closed.',
      inputSchema:z.object({id:z.string().uuid(),installationId:z.string().regex(/^[1-9][0-9]{0,19}$/).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,installationId})=>this.safeTool(()=>
      this.connections.beginGithub(this.connectorOwner(),id,installationId)));

    server.registerTool('nyx_connection_github_repository',{
      title:'Inspect an authorized GitHub repository',
      description:'Read-only GitHub REST repository metadata with repo-scoped App token.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.repository(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_issues',{
      title:'List open issues in my authorized repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.issues(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_pulls',{
      title:'List open pull requests in my authorized repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.pullRequests(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_file',{
      title:'Read a bounded text file from my authorized GitHub repository',
      description:'Read-only Contents REST API. Limits files to 64 KiB and validates path and branch.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        path:z.string().min(1).max(600),ref:z.string().min(1).max(120)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,path,ref})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.fileText(this.connectorOwner(),id,repo,path,ref))));

    server.registerTool('nyx_connection_github_branches',{
      title:'List branches through authorized GitHub API',
      description:'Read-only, bounded GitHub REST branch metadata. Branch-scoped access cannot enumerate unrestricted branches.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.branches(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_commits',{
      title:'Read recent commits on an allowed GitHub branch',
      description:'Bounded summaries only; per-repository and per-branch permissions enforced.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),branch:z.string().min(1).max(120)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.commits(this.connectorOwner(),id,repo,branch))));

    server.registerTool('nyx_connection_github_releases',{
      title:'Read GitHub releases through authorized API',
      description:'Read-only, bounded release metadata without downloads or deployment.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.releases(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_workflows',{
      title:'Read workflows from my authorized GitHub repository',
      description:'Read-only Actions API; owner, installation, selected repository and provider grants checked.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.workflows(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_runs',{
      title:'Read Actions runs in my authorized GitHub repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),branch:z.string().max(120).optional()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.runs(this.connectorOwner(),id,repo,branch))));

    server.registerTool('nyx_connection_github_jobs',{
      title:'Read jobs of an authorized GitHub Actions run',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),runId:z.number().int().positive()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,runId})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.jobs(this.connectorOwner(),id,repo,runId))));

    // GitHub API writes are restricted to owner-selected repositories and
    // review-only nyx/* branches. No workflow dispatch, merges or hosting API.
    server.registerTool('nyx_connection_github_branch_create',{
      title:'Create a non-default GitHub working branch (not main/master/default)',
      description:'Create a nyx-prefixed branch from the current default HEAD in one authorized repository. Never modifies the default branch.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(1).max(100)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.createBranch(this.connectorOwner(),id,repo,branch))));

    // SHA-guarded staging workflow: changes only a fresh nyx-prefixed review branch.
    // Both base and target refuse master/main/default. No direct protected writes.
    server.registerTool('nyx_connection_github_branch_from_ref',{
      title:'Create a SHA-guarded review branch from tester or another non-default branch',
      description:'Create a nyx-prefixed branch from the exact verified tip of a non-protected, non-default branch. Requires expectedBaseSha; never modifies the source branch.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(5).max(100),baseBranch:z.string().min(1).max(100),
        expectedBaseSha:z.string().regex(/^[a-f0-9]{40}$/)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch,baseBranch,expectedBaseSha})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.createFromNonDefault(
        this.connectorOwner(),id,repo,branch,baseBranch,expectedBaseSha))));

    server.registerTool('nyx_connection_github_stage_tester_from_dev',{
      title:'Stage reviewed Dev source files as a draft-ready tester review branch',
      description:'Copy up to 40 exact reviewed src/docs/tests files from a selected YaRoute-Dev commit into a NEW nyx-prefixed review branch based on a verified YaRoute tester SHA. Uses two owner-scoped GitHub App connections. Never updates tester/master, creates deployment files, merges, or deploys. Call draft_pr_to_ref separately after inspecting staged changes.',
      inputSchema:z.object({
        sourceConnectionId:z.string().uuid(),destinationConnectionId:z.string().uuid(),
        sourceRepo:z.string().min(3).max(200),destinationRepo:z.string().min(3).max(200),
        sourceBranch:z.string().min(1).max(100),
        expectedSourceSha:z.string().regex(/^[a-f0-9]{40}$/),
        expectedTesterSha:z.string().regex(/^[a-f0-9]{40}$/),
        reviewBranch:z.string().min(5).max(100),
        paths:z.array(z.string().min(1).max(400)).min(1).max(40),
      }),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({sourceConnectionId,destinationConnectionId,sourceRepo,destinationRepo,
       sourceBranch,expectedSourceSha,expectedTesterSha,reviewBranch,paths})=>
      this.safeTool(()=>this.limitedConnectionApi(destinationConnectionId,()=>
        this.githubWrites.stageTesterFromDev(this.connectorOwner(),
          sourceConnectionId,destinationConnectionId,sourceRepo,destinationRepo,
          sourceBranch,expectedSourceSha,expectedTesterSha,reviewBranch,paths))));

    server.registerTool('nyx_connection_github_reviewed_pr_to_ref',{
      title:'Open an exact-SHA reviewed PR into tester or another unprotected non-default branch',
      description:'Creates a non-draft PR for a nyx-prefixed source with verified source/target SHAs. No protected master/main, no automatic merge or deployment. Use the separately gated merge_reviewed_nondefault tool after CI.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(5).max(100),baseBranch:z.string().min(1).max(100),
        title:z.string().min(1).max(200),body:z.string().max(10000).optional(),
        expectedHeadSha:z.string().regex(/^[a-f0-9]{40}$/),
        expectedBaseSha:z.string().regex(/^[a-f0-9]{40}$/)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch,baseBranch,title,body,expectedHeadSha,expectedBaseSha})=>
      this.safeTool(()=>this.limitedConnectionApi(id,()=>
        this.githubWrites.openReviewedNonDefault(this.connectorOwner(),
          id,repo,branch,baseBranch,title,body||'',expectedHeadSha,expectedBaseSha))));

    server.registerTool('nyx_connection_github_draft_pr_to_ref',{
      title:'Open an unmerged draft PR to tester or another non-default branch',
      description:'Open a DRAFT PR from a nyx-prefixed review branch to a non-default branch. Never merges, deploys, dispatches workflows or targets protected main/master.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(5).max(100),baseBranch:z.string().min(1).max(100),
        title:z.string().min(1).max(200),body:z.string().max(10000).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch,baseBranch,title,body})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.draftPullToNonDefault(
        this.connectorOwner(),id,repo,branch,baseBranch,title,body))));

    server.registerTool('nyx_connection_github_merge_reviewed_nondefault',{
      title:'Merge a CI-verified NYX review PR into an unprotected non-default branch',
      description:'Explicit merge only of same-repo nyx-prefixed review PR. Checks precise head and base SHAs, protected status and completed successful CI. Cannot merge master/main/default and never invokes Heroku.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        prNumber:z.number().int().min(1).max(1000000),
        expectedHeadSha:z.string().regex(/^[a-f0-9]{40}$/),
        expectedBaseSha:z.string().regex(/^[a-f0-9]{40}$/)}),
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
    },async({id,repo,prNumber,expectedHeadSha,expectedBaseSha})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.mergeReviewedNonDefault(
        this.connectorOwner(),id,repo,prNumber,expectedHeadSha,expectedBaseSha))));

    server.registerTool('nyx_connection_github_tester_release_pr',{
      title:'Prepare a reviewed draft tester-to-master release PR',
      description:'Only creates a DRAFT PR from an exact approved tester commit to a verified protected main/master. Detects existing PRs. Never changes branches, merges, dispatches CI or deploys.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        expectedTesterSha:z.string().regex(/^[a-f0-9]{40}$/),
        title:z.string().min(1).max(200),
        body:z.string().max(10000).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,expectedTesterSha,title,body})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.draftTesterRelease(
        this.connectorOwner(),id,repo,expectedTesterSha,title,body))));

    server.registerTool('nyx_connection_github_commit_file',{
      title:'Commit one file on a NYX review branch',
      description:'Create or update one UTF-8 file on an existing nyx-prefixed branch; requires GitHub Contents write. Workflow, hosting, CI script, credential and deployment files are blocked.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(1).max(100),path:z.string().min(1).max(400),
        content:z.string().max(65536),message:z.string().min(1).max(160),
        sha:z.string().regex(/^[a-f0-9]{40}$/).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch,path,content,message,sha})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.commitFile(this.connectorOwner(),id,repo,branch,path,content,message,sha))));

    server.registerTool('nyx_connection_github_draft_pr',{
      title:'Open a draft PR for a NYX branch',
      description:'Open a draft pull request from a nyx-prefixed branch to the repository default branch. No merging, deployments or workflow runs are authorized.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        branch:z.string().min(1).max(100),title:z.string().min(1).max(200),
        body:z.string().max(10000).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,branch,title,body})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.draftPull(this.connectorOwner(),id,repo,branch,title,body))));

    server.registerTool('nyx_connection_github_issue_create',{
      title:'Create an issue in an authorized GitHub repository',
      description:'Create an issue through the GitHub API with an installation-scoped issues:write grant. No issue-triggered workflow dispatch is authorized.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        title:z.string().min(1).max(200),body:z.string().max(10000).optional()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,repo,title,body})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubWrites.createIssue(this.connectorOwner(),id,repo,title,body))));


    // Per-owner storage connection metadata and read-probe onboarding. Registered
    // only for the isolated opt-in public runtime. Private legacy remotes remain
    // in their existing restricted worker, never reachable through these tools.
    if (process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' &&
        process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') {
      server.registerTool('nyx_storage_connections_list', {
        title: 'List my independent Google Drive and MEGA connections',
        description: 'Owner-scoped storage connections only, with no credentials or legacy rclone configuration.',
        inputSchema: z.object({}),
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
      }, async () => this.safeTool(() => this.connections.listStorage(this.connectorOwner())));

      server.registerTool('nyx_storage_connection_create', {
        title: 'Add a separate storage connection',
        description: 'Create a pending owner-specific Google Drive or MEGA connection without provider grants or secret input. Provider sign-in is required separately.',
        inputSchema: z.object({provider: z.enum(['google-drive', 'mega']), name: z.string().min(1).max(80)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
      }, async ({provider,name}) => this.safeTool(() =>
        this.connections.createStorage(this.connectorOwner(),provider,name)));

      server.registerTool('nyx_storage_connection_permissions', {
        title: 'Select read-only storage permission',
        description: 'Set storage:list only. A user selection cannot grant provider permissions.',
        inputSchema: z.object({id: z.string().uuid(),capabilities: z.array(z.literal('storage:list')).max(1)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
      }, async ({id,capabilities}) => this.safeTool(() =>
        this.connections.storagePermissions(this.connectorOwner(),id,capabilities)));

      server.registerTool('nyx_storage_connection_roots', {
        title: 'Set exact storage root boundaries',
        description: 'Select explicit Drive folder ID or MEGA relative-root; never provide rclone remote names or credentials.',
        inputSchema: z.object({id:z.string().uuid(),resources:z.array(z.object({
          kind:z.enum(['drive','mega-root']),
          id:z.string().min(1).max(256),
          capabilities:z.array(z.literal('storage:list')).min(1).max(1),
        }).strict()).max(10)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
      }, async ({id,resources}) => this.safeTool(() =>
        this.connections.storageResources(this.connectorOwner(),id,resources as ConnectorResourceRule[])));

      server.registerTool('nyx_storage_connection_begin_google', {
        title:'Authorize Google Drive for one NestNyx connection',
        description:'Generate a ten-minute, owner-bound Google OAuth URL using PKCE and read-only Drive scope. Requires selected Drive folder ID. Sign in using Google; do not send tokens in chat.',
        inputSchema:z.object({id:z.string().uuid(),folderId:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)}),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
      },async({id,folderId})=>this.safeTool(()=>
        this.tenantGoogle.begin(this.connectorOwner(),id,folderId)));

      server.registerTool('nyx_storage_connection_begin_mega', {
        title:'Open a secure MEGA account sign-in form',
        description:'Create an expiring HTTPS link for MEGA sign-in. Enter passwords ONLY on the first-party NestNyx page, never in ChatGPT. Does not ask to disable 2FA.',
        inputSchema:z.object({id:z.string().uuid(),rootPath:z.string().min(1).max(256)}),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
      },async({id,rootPath})=>this.safeTool(()=>
        this.tenantMega.begin(this.connectorOwner(),id,rootPath)));

      server.registerTool('nyx_storage_connection_test_pending', {
        title: 'Check pending connection connectivity',
        description: 'Read-only isolated rclone probe; uses only the owner-scoped pending secret previously staged through verified provider authorization.',
        inputSchema: z.object({id:z.string().uuid()}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
      }, async ({id}) => this.safeTool(() =>
        this.tenantRclone.probePending(this.connectorOwner(),id)));

      server.registerTool('nyx_storage_connection_activate', {
        title: 'Activate a successfully verified storage connection',
        description: 'Requires provider verified grant, scoped user-selected permission and fresh successful read test. Does not change existing legacy connections.',
        inputSchema: z.object({id:z.string().uuid()}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
      }, async ({id}) => this.safeTool(() =>
        this.tenantRclone.activate(this.connectorOwner(),id)));
      server.registerTool('nyx_storage_connection_list_files', {
        title:'List my MEGA or Google Drive folder from my independent connection',
        description:'Read-only: lists up to 100 names from the exact owner-authorized root. Uses an isolated per-connection Rclone config, never private legacy credentials. Does not read file contents, copy, modify or delete.',
        inputSchema:z.object({
          id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
          rootId:z.string().min(1).max(256),
          path:z.string().max(2048).optional(),
        }),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      },async({id,provider,rootId,path})=>this.safeTool(()=>
        this.tenantRclone.listAuthorizedRoot(
          this.connectorOwner(),id,provider,rootId,path||'')));

      server.registerTool('nyx_storage_connection_test_active', {
        title: 'Verify read access to my active isolated storage root',
        description: 'Read-only Rclone probe using only the authenticated owner, one activated connection and its exact selected root. Never uses private global Rclone configuration or returns file names.',
        inputSchema: z.object({
          id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
          rootId:z.string().min(1).max(256),
          path:z.string().max(2048).optional(),
        }),
        annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      }, async ({id,provider,rootId,path}) => this.safeTool(() =>
        this.tenantRclone.probeAuthorizedRoot(
          this.connectorOwner(),id,provider,rootId,path || '')));
    }

    // Public multi-user connector mode deliberately omits all legacy global
    // storage roots, Rclone, NYX CLI commands and cross-user private handoffs.
    if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;

    // Private-only, read-only discovery of configured Rclone remotes. Never
    // expose the operator's Rclone config, tokens, remote options or file contents.
    // This is auxiliary MCP metadata, NOT a canonical Head/Yaro CLI command.
    server.registerTool('nyx_rclone_connections_list',{
      title:'List configured private Google Drive and MEGA Rclone remotes',
      description:'Read-only: list the Google Drive and MEGA remote names and safe logical aliases configured in the private Rclone runtime. Does not test online availability or expose credentials.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(()=>{
      this.connectorOwner();
      return this.storage.rcloneConnections();
    }));

    server.registerTool('nyx_rclone_connection_test_read',{
      title:'Test configured Rclone read connectivity',
      description:'Probe read-only root listing for a configured remote; no write test.',
      inputSchema:z.object({provider:z.enum(['google-drive','mega']),name:z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/)}),
      _meta:{ui:{visibility:['app']}},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({provider,name})=>this.safeTool(()=>{
      this.connectorOwner();
      return this.storage.probeRcloneConnection(provider,name);
    }));
    // Private-only operational tools. These are MCP auxiliaries and must not
    // silently introduce new canonical Yaro CLI commands or execution contracts.
    server.registerTool('nyx_head_status',{
      title:'Verify the current canonical NYX Head and CLI',
      description:'Read canonical Head/CLI version, hash and verified cache metadata from the current NYX bootstrap. Does not modify any bundle.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>{
      this.connectorOwner();
      const locator=await this.bootstrap.locate();
      const {cli,hash}=await this.cliRegistry.current(locator);
      return {
        status:'READY',role:'constitution-library',canonical:locator.canonical,
        cli:{version:cli.version,sha256:hash},
        library:this.headLibrary.snapshot(),
        source_of_truth:'canonical Head bundle',
        mutation:'read-only runtime cache; canonical Head lifecycle remains separate',
      };
    }));
    server.registerTool('nyx_areas',{
      title:'List logical NYX storage areas',
      description:'List storage-area aliases configured and discovered in private NYX. Read-only; these are storage aliases, not Head project areas.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>({areas:await this.storage.areas()})));

    server.registerTool('nyx_list',{
      title:'List files and folders in a selected NYX storage area',
      description:'Read-only, path-bound list for an existing configured storage area; no configuration or credentials exposed.',
      inputSchema:z.object({area:z.string().min(1).max(128),path:z.string().default('')}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({area,path})=>this.safeTool(()=>this.storage.list(area,path)));

    server.registerTool('nyx_stat',{
      title:'Read metadata for one NYX storage path',
      description:'Read-only metadata for a file or folder below a selected logical storage area.',
      inputSchema:z.object({area:z.string().min(1).max(128),path:z.string().min(1).max(2048)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({area,path})=>this.safeTool(()=>this.storage.stat(area,path)));

    server.registerTool('nyx_capacity',{
      title:'Read NYX configured storage capacities',
      description:'Read-only quota summaries for allowed logical storage areas; never returns secrets.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(()=>this.storage.capacity()));

    server.registerTool('nyx_job_status',{
      title:'Check NYX storage job status',
      description:'Read an existing private NYX storage job and its verification result. Does not create, alter or cancel jobs.',
      inputSchema:z.object({id:z.string().uuid()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({id})=>this.safeTool(async()=>{
      const job=await this.jobs.get(id);
      if(!job)throw new Error('JOB_NOT_FOUND');
      return {job};
    }));

    server.registerTool(
      'nyx_help',
      {
        title: 'Help: list canonical Yaro commands and live support',
        description: 'Read-only explanation of Head commands, syntax and scopes, with executable availability from the current verified runtime profile. Canonical command is hel; help is a spelling alias.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => this.safeTool(() => this.commands.execute({ command: 'hel' }, this.ownerContext.getStore())),
    );

    server.registerTool(
      'nyx_execute',
      {
        title: 'Execute a Nyx command',
        description: 'Check current CLI authority, resolve its typed execution contract and load only required resources. Requires a private bootstrap locator. Initialization returns verified private FIF and files_to_paste.',
        inputSchema: z.object({
          command: z.string().min(1).max(64),
          args: z.array(z.string().min(1).max(64)).max(16).default([]),
          depth: z.enum(['basic', 'normal', 'deep']).optional(),
          conversationId: z.string().min(1).max(256).optional(),
          payload: z.object({
            title: z.string().min(1).max(200),
            summary: z.string().min(1).max(100000),
            messageCount: z.union([z.number().int().nonnegative(), z.literal('UNKNOWN')]).optional(),
            compactContext: z.string().max(20000).optional(),
            urgentItems: z.array(z.string().min(1).max(2000)).max(64).default([]),
            nextAction: z.string().max(5000).optional(),
          }).strict().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async input => this.safeTool(() => this.commands.execute(input, this.ownerContext.getStore())),
    );
    server.registerTool(
      'nyx_ini',
      {
        title: 'Initialize Nyx working context',
        description: 'Compatibility wrapper for current CLI ini. Returns FIF receipt, files_to_paste and metadata. Reuse returned conversation_id as sessionId on subsequent calls; no heavy audit fallback.',
        inputSchema: z.object({ target: z.string().min(1).max(1024).optional(), targets: z.array(z.string().min(1).max(64)).max(16).optional(), scope: z.enum(['local', 'global']).optional(), sessionId: z.string().uuid().optional(), depth: z.enum(['basic', 'normal', 'deep']).optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async input => this.safeTool(() => this.init.initialize(input, this.ownerContext.getStore())),
    );

    server.registerTool(
      'nyx_sum',
      {
        title: 'Summarize and checkpoint Nyx conversation',
        description: 'Update the active conversation FIF with current continuity, then promote or revise it as a verified FIB while preserving the same conversation artifact identity.',
        inputSchema: z.object({
          sessionId: z.string().uuid(),
          title: z.string().min(1).max(200),
          summary: z.string().min(1).max(100000),
          messageCount: z.union([z.number().int().nonnegative(), z.literal('UNKNOWN')]).optional(),
          compactContext: z.string().max(20000).optional(),
          urgentItems: z.array(z.string().min(1).max(2000)).max(64).default([]),
          nextAction: z.string().max(5000).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => this.safeTool(() => this.commands.execute({
        command: 'sum',
        conversationId: input.sessionId,
        payload: {
          title: input.title,
          summary: input.summary,
          messageCount: input.messageCount,
          compactContext: input.compactContext,
          urgentItems: input.urgentItems,
          nextAction: input.nextAction,
        },
      }, this.ownerContext.getStore())),
    );

    server.registerTool(
      'nyx_mega_accounts',
      {
        title: 'List configured MEGA accounts',
        description:
          'List safe logical aliases for MEGA remotes discovered from the private rclone config, plus explicitly configured MEGA roots. Remote names and credentials are not exposed.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.safeTool(async () => ({ accounts: await this.storage.megaAreas() })),
    );

    server.registerTool(
      'nyx_mega_list',
      {
        title: 'Browse a configured MEGA account',
        description:
          'List files and folders below one explicitly configured MEGA root. Paths cannot escape that root.',
        inputSchema: z.object({
          account: z.string().min(1).describe('Logical MEGA account alias, not a raw rclone remote name.'),
          path: z.string().default('').describe('Relative path below the configured MEGA root.'),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ account, path }) => this.safeTool(() => this.storage.megaList(account, path)),
    );

    server.registerTool(
      'nyx_mega_stat',
      {
        title: 'Inspect a file in MEGA',
        description:
          'Read metadata, hashes and size for one path below an explicitly configured MEGA root.',
        inputSchema: z.object({
          account: z.string().min(1),
          path: z.string().min(1),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ account, path }) => this.safeTool(() => this.storage.megaStat(account, path)),
    );

    server.registerTool(
      'nyx_mega_capacity',
      {
        title: 'Check MEGA capacity',
        description:
          'Report quota total, used, and free bytes only for explicitly configured MEGA accounts.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.safeTool(() => this.storage.megaCapacity()),
    );

    server.registerTool(
      'nyx_global_index',
      {
        title: 'Regenerate NYX file global indexes',
        description:
          'Queue a metadata-only scan of every currently accessible storage source and regenerate global.md, n_global.json, and d_global.json in the private Nyxpad file_global_indexes folder. File contents and credentials are not read.',
        inputSchema: z.object({
          snapshot: z.boolean().optional().default(true),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ snapshot }) => this.safeTool(async () => {
        const job = await this.jobs.createGlobalIndex({ snapshot });
        return {
          job,
          destination: {
            area: 'MAIN',
            root: 'Documents/Nyxpad/file_global_indexes',
            files: ['global.md', 'n_global.json', 'd_global.json'],
          },
          message: 'Global file indexing queued. Use the internal job workflow to check completion.',
        };
      }),
    );

    server.registerTool(
      'nyx_copy_file',
      {
        title: 'Copy a file between shared areas',
        description: 'Queue a cross-area file copy. NestNyx refuses destination clobbering and verifies size, a common hash, and destination owner. MEGA copies remain disabled until provider-specific verification is implemented.',
        inputSchema: z.object({
          sourceArea: z.string().min(1),
          sourcePath: z.string().min(1),
          destinationArea: z.string().min(1),
          destinationPath: z.string().min(1),
          verify: z.boolean().optional().default(true),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ sourceArea, sourcePath, destinationArea, destinationPath, verify }) => this.safeTool(async () => {
        const payload: CopyJobPayload = {
          source: { area: sourceArea, path: sourcePath },
          destination: { area: destinationArea, path: destinationPath },
          verify,
        };
        this.storage.validateCopyPayload(payload);
        const job = await this.jobs.createCopy(payload);
        return {
          job,
          sourceRetained: true,
          message: 'Copy queued. Use the internal job workflow to check completion.',
        };
      }),
    );

    return server;
  }

  private async limitedConnectionApi<T>(connectionId:string,fn:()=>Promise<T>):Promise<T> {
    const owner=this.connectorOwner();
    await this.connections.consumeQuota(owner,connectionId);
    return fn();
  }

  private connectorOwner():string {
    const owner=this.ownerContext.getStore();
    if(!owner || !owner.startsWith('oauth:')) throw new Error('CONNECTOR_OWNER_REQUIRED');
    return owner;
  }

  private async safeTool(action: () => unknown | Promise<unknown>) {
    try {
      const result = await action();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const message = /^[A-Z][A-Z_]+(?::[A-Za-z0-9_:.-]{1,128})?$/.test(raw) ? raw : 'NYX_OPERATION_FAILED';
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      };
    }
  }
}
