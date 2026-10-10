import { AsyncLocalStorage } from 'node:async_hooks';
import { NyxCommandExecutor } from '../nyx/command-executor.service';
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
import { GithubReadonlyConnector } from '../connectors/github-readonly';
import { CONNECTIONS_PANEL_URI, CONNECTIONS_PANEL_HTML } from '../connectors/connections-panel';
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
    private readonly connections: ConnectorsService,
    private readonly github: GithubReadonlyConnector,
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
      version: '0.8.1',
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
          ini: { tool: 'nyx_ini', status: 'registered' },
          sum: { tool: 'nyx_sum', status: 'registered' },
        },
        auxiliaryTools: process.env.NYX_DEPLOYMENT_MODE === 'public' ? ['nyx_connections_panel','nyx_connections_list','nyx_risk_preview'] : ['nyx_mega_accounts', 'nyx_mega_list', 'nyx_mega_stat', 'nyx_mega_capacity', 'nyx_global_index', 'nyx_copy_file', 'nyx_risk_preview','nyx_connections_panel'],
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
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
          'openai/widgetCSP':{redirect_domains:['https://github.com']},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
      }]}),
    );

    server.registerTool('nyx_connections_panel',{
      title:'Manage NestNyx connections',
      description:'Open the GitHub-only NestNyx connections panel to authorize GitHub App and select repository permissions. This is an MCP auxiliary tool, not a Yaro CLI command.',
      inputSchema:z.object({}),
      _meta:{ui:{resourceUri:CONNECTIONS_PANEL_URI,visibility:['model','app']},'openai/outputTemplate':CONNECTIONS_PANEL_URI},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>({
      schema:'nyx.connections.panel.v1',
      ownerId:this.connectorOwner(),
      connections:await this.connections.list(this.connectorOwner()),
      providers:[
        {id:'github',availability:'oauth_ready_if_configured'},
      ],
      note:'GitHub authorization is required. Refresh the ChatGPT MCP connection to discover new tools.',
    })));

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

    server.registerTool('nyx_connection_begin_github',{
      title:'Authorize my GitHub App installation',
      description:'One-time, state-bound GitHub user OAuth authorization. Requires a manually installed GitHub App. Does not reveal credentials.',
      inputSchema:z.object({id:z.string().uuid(),installationId:z.string().regex(/^[1-9][0-9]{0,19}$/)}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async({id,installationId})=>this.safeTool(()=>
      this.connections.beginGithub(this.connectorOwner(),id,installationId)));

    server.registerTool('nyx_connection_github_repository',{
      title:'Inspect an authorized GitHub repository',
      description:'Read-only GitHub REST repository metadata with repo-scoped App token.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.repository(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_issues',{
      title:'List open issues in my authorized repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.issues(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_pulls',{
      title:'List open pull requests in my authorized repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.pullRequests(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_file',{
      title:'Read a bounded text file from my authorized GitHub repository',
      description:'Read-only Contents REST API. Limits files to 64 KiB and validates path and branch.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        path:z.string().min(1).max(600),ref:z.string().min(1).max(120)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,path,ref})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.fileText(this.connectorOwner(),id,repo,path,ref))));

    server.registerTool('nyx_connection_github_branches',{
      title:'List branches through authorized GitHub API',
      description:'Read-only, bounded GitHub REST branch metadata. Branch-scoped access cannot enumerate unrestricted branches.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.branches(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_commits',{
      title:'Read recent commits on an allowed GitHub branch',
      description:'Bounded summaries only; per-repository and per-branch permissions enforced.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),branch:z.string().min(1).max(120)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.commits(this.connectorOwner(),id,repo,branch))));

    server.registerTool('nyx_connection_github_releases',{
      title:'Read GitHub releases through authorized API',
      description:'Read-only, bounded release metadata without downloads or deployment.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.releases(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_workflows',{
      title:'Read workflows from my authorized GitHub repository',
      description:'Read-only Actions API; owner, installation, selected repository and provider grants checked.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.workflows(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_runs',{
      title:'Read Actions runs in my authorized GitHub repository',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),branch:z.string().max(120).optional()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.runs(this.connectorOwner(),id,repo,branch))));

    server.registerTool('nyx_connection_github_jobs',{
      title:'Read jobs of an authorized GitHub Actions run',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),runId:z.number().int().positive()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,runId})=>this.safeTool(()=>
      this.readConnectionApi(id,()=>this.github.jobs(this.connectorOwner(),id,repo,runId))));

    // Public multi-user connector mode deliberately omits all legacy global
    // storage roots, Rclone, NYX CLI commands and cross-user private handoffs.
    if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;

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

  private async readConnectionApi<T>(connectionId:string,fn:()=>Promise<T>):Promise<T> {
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
