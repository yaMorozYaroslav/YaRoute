import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { NyxCommandExecutor } from '../nyx/command-executor.service';
import { NyxBootstrapService } from '../nyx/bootstrap.service';
import { NyxCliRegistryService } from '../nyx/cli-registry.service';
import { NyxHeadLibraryService } from '../nyx/head-library.service';
import { NyxKeyService } from '../nyx/key.service';
import { NyxTenantKeyService } from '../nyx/tenant-key.service';
import { preparePublicIniPlan } from '../nyx/public-init-plan';
import { extractKeySignals } from '../nyx/key-chat-extractor';
import { RuntimeMaintenanceService } from './runtime-maintenance.service';
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
import { TenantRcloneUploadService } from '../connectors/tenant-rclone-upload.service';
import { TenantGoogleOAuthService } from '../connectors/tenant-google-oauth.service';
import { TenantMegaEnrollmentService } from '../connectors/tenant-mega-enrollment.service';
import { publicTenantMegaOnly } from '../connectors/public-tenant-provider.policy';
import { PrivateLegacyOwnerLinkService } from '../connectors/private-legacy-owner-link.service';
import { PrivateLegacyBrokerClient } from '../connectors/private-legacy-broker.client';
import { GithubReadonlyConnector } from '../connectors/github-readonly';
import { GithubWriteConnector } from '../connectors/github-writes';
import { HerokuBrokerClient } from '../connectors/heroku-broker.client';
import { herokuReadAuthorization } from '../connectors/heroku-read-policy';
import { GithubAppService, githubInstallationUrl } from '../connectors/github-app.service';
import { CONNECTIONS_PANEL_URI, CONNECTIONS_PANEL_HTML, CONNECTIONS_HOME_URI, CONNECTIONS_HOME_HTML, CONNECTIONS_PANEL_LABEL, CONNECTIONS_HOME_LABEL, CONNECTIONS_PANEL_BRAND_ORIGIN } from '../connectors/connections-panel';
import type { ConnectorCapability, ConnectorResourceRule } from '../connectors/connector-registry';
import { ACCOUNT_VIEW_URI, ACCOUNT_VIEW_HTML, signStorageView, verifyStorageView } from '../connectors/multi-account-view';
import { compatibilityResourceUri } from './mcp-ui-version';
import { PRIVATE_REMOTE_ROOT, findPrivateRemote, privateRemoteView,
  type ApprovedPrivateRemote } from '../connectors/private-pro-virtual-connections';

@Injectable()
export class McpService {
  private readonly ownerContext = new AsyncLocalStorage<string>();
  private readonly signedDisplayContext = new AsyncLocalStorage<{
    email: string | null; name: string | null; picture: string | null;
  }>();
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
    private readonly keys: NyxKeyService,
    private readonly tenantKeys: NyxTenantKeyService,
    private readonly connections: ConnectorsService,
    private readonly tenantRclone: TenantRcloneService,
    private readonly tenantRcloneUpload: TenantRcloneUploadService,
    private readonly tenantGoogle: TenantGoogleOAuthService,
    private readonly tenantMega: TenantMegaEnrollmentService,
    private readonly github: GithubReadonlyConnector,
    private readonly githubApp: GithubAppService,
    private readonly githubWrites: GithubWriteConnector,
    private readonly herokuBroker: HerokuBrokerClient,
    private readonly maintenance: RuntimeMaintenanceService,
    private readonly ownerLink: PrivateLegacyOwnerLinkService,
    private readonly privateBroker: PrivateLegacyBrokerClient,
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
    const display = {
      email: typeof res.locals.nyxVerifiedEmail === 'string' ? res.locals.nyxVerifiedEmail : null,
      name: typeof res.locals.nyxDisplayName === 'string' ? res.locals.nyxDisplayName : null,
      picture: typeof res.locals.nyxProfilePicture === 'string' ? res.locals.nyxProfilePicture : null,
    };
    await this.ownerContext.run(`oauth:${res.locals.nyxSubject}`, () =>
      this.signedDisplayContext.run(display, () => this.nodeHandler(req, res, parsedBody)));
  }

  private buildServer() {
    const server = new McpServer({
      name: 'NestNyx',
      version: '0.8.2',
      icons: CONNECTIONS_PANEL_BRAND_ORIGIN ? [{src:CONNECTIONS_PANEL_BRAND_ORIGIN+'/branding/icon.png',mimeType:'image/png',sizes:['96x96']}] : [],
    });

    // Minimal read-only MCP Apps delivery probe. If this static resource does
    // not render in ChatGPT while the tool responds, the failure is in host
    // resource retrieval or app registration rather than Connections JS.
    const diagnosticUi='ui://nestnyx/diagnostic/v1.html';
    server.registerResource('NestNyx UI Diagnostic',diagnosticUi,
      {mimeType:'text/html;profile=mcp-app'},
      async()=>({contents:[{
        uri:diagnosticUi,mimeType:'text/html;profile=mcp-app',
        text:'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NestNyx UI Diagnostic</title></head><body><main style="font:16px system-ui;padding:24px"><h1>NestNyx UI resource loaded</h1><p>This is a static, read-only rendering check. No credentials or storage were accessed.</p></main></body></html>',
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}},
      }]}));
    server.registerTool('nyx_ui_diagnostic',{
      title:'Open NestNyx UI diagnostic',
      description:'Show a minimal static MCP Apps resource to distinguish ChatGPT UI-resource failures from NestNyx Connections JavaScript problems. Does not access private data or change storage.',
      inputSchema:z.object({}),
      _meta:{ui:{resourceUri:diagnosticUi,visibility:['model','app']},
        'openai/outputTemplate':diagnosticUi},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>({schema:'nyx.ui-diagnostic.v1',result:'resource-requested',
      noCredentialsRead:true,noStorageAccess:true})));

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
        // Public tenants deliberately cannot access the private MAIN bootstrap.
        // Advertise only tools that are registered for this deployment mode.
        initialization: process.env.NYX_DEPLOYMENT_MODE === 'public'
          ? {
            available: false,
            reason: 'PRIVATE_BOOTSTRAP_NOT_EXPOSED_TO_PUBLIC_TENANTS',
            // This is an authorization boundary, not proof of a broken CLI.
            // A separate ChatGPT/Drive read is possible only with its own grants.
            alternative: 'separate-authorized-ChatGPT-source-resolution',
            assisted: {tool:'nyx_ini_plan', mode:'read-only-external-source-preflight', status:'PARTIAL_DIAGNOSTIC', nativeFif:false},
          }
          : { available: true, status: 'registered-requires-verified-bootstrap' },
        sourceRecovery: {
          inaccessibleDriveId: 'Resolve the source owner and use that authorized Drive account for the exact read. A 404 under a different connected account is an access mismatch, not proof of deletion. Re-discover in the verified source owner account; never silently switch owners or change access.',
          authorityOrder: 'current-valid-Footer -> referenced-Head-and-Body -> owning-Area-sources',
          completionGate: 'No canonical-initialization COMPLETE or FIF verification without those live receipts.',
          privateBoundary: 'Never route public MCP tenants into the private MAIN bootstrap.',
        },
        commandEntrypoints: process.env.NYX_DEPLOYMENT_MODE === 'public' ? {} : {
          execute: { tool: 'nyx_execute', commands: 'backend-resolved; not all Head commands guaranteed' },
          help: { tool: 'nyx_help', command: 'hel', mode: 'read-only' },
          ini: { tool: 'nyx_ini', status: 'registered-requires-verified-bootstrap' },
          sum: { tool: 'nyx_sum', status: 'registered-requires-verified-bootstrap' },
        },
        auxiliaryTools: process.env.NYX_DEPLOYMENT_MODE === 'public' ?
          ['nyx_ini_plan','get_profile','nyx_connections_home','nyx_connections_panel','nyx_connections_list','nyx_risk_preview',
            'nyx_account_view_snapshot','nyx_accounts_view',
           ...(process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
               process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' ?
            ['nyx_storage_connections_list','nyx_storage_connection_create',
             'nyx_storage_connection_rename',
             'nyx_storage_connection_permissions','nyx_storage_connection_roots',
             'nyx_storage_connection_begin_google','nyx_storage_connection_begin_mega',
             'nyx_storage_connection_test_pending','nyx_storage_connection_activate',
             'nyx_storage_connection_test_active','nyx_storage_connection_list_files',
              ...(process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED === 'true' ? ['nyx_storage_connection_begin_import','nyx_storage_connection_begin_import_all','nyx_storage_connection_finish_import'] : []),
              'nyx_storage_connection_revoke','nyx_storage_connection_select_best',
              ...(process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED === 'true' ?
                ['nyx_storage_google_verify_rw','nyx_storage_google_file_mutate'] : []),
              ...(process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED === 'true' ||
                  process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED === 'true' ?
                ['nyx_storage_text_file_create'] : []),
              ...(process.env.NYX_PUBLIC_TRASH_CLEANUP_ENABLED === 'true' ? ['nyx_storage_trash_cleanup'] : []),
              ...(process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED === 'true' ?
                ['nyx_storage_mega_file_mutate'] : [])] : []),
           ...(process.env.NYX_PRIVATE_OWNER_LINK_ENABLED === 'true' ? ['nyx_private_owner_link_status','nyx_private_owner_link_begin'] : []),
            ...(process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED === 'true' ? ['nyx_private_legacy_roots','nyx_private_legacy_list'] : []),
           ...(process.env.NYX_HEROKU_READ_ENABLED === 'true' ? ['nyx_heroku_app_info','nyx_heroku_releases'] : [])] : ['nyx_mega_accounts', 'nyx_mega_list', 'nyx_mega_stat', 'nyx_mega_capacity', 'nyx_global_index', 'nyx_copy_file', 'nyx_risk_preview','nyx_connections_home','nyx_connections_panel','nyx_rclone_connections_list','nyx_head_status','nyx_areas','nyx_list','nyx_stat','nyx_capacity','nyx_job_status','nyx_maintenance_runtime_inspect','nyx_maintenance_runtime_prepare',
           ...(process.env.NYX_HEROKU_READ_ENABLED === 'true' ? ['nyx_heroku_app_info','nyx_heroku_releases'] : [])],
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

    // Backward compatibility for authenticated ChatGPT clients that cached the
    // v9 UI URI before Dev/Tester switched to environment-specific v10 keys.
    // Keep the old key temporarily to prevent "App unavailable" on resource read.
    // The legacy resource renders the same current, owner-scoped UI and cannot
    // access private Rclone credentials from the public tenant deployment.
    const legacyConnectionsResourceUri='ui://nestnyx/connections/v9.html';
    server.registerResource(
      'NestNyx Connections (legacy UI)',legacyConnectionsResourceUri,
      {mimeType:'text/html;profile=mcp-app'},
      async()=>({contents:[{
        uri:legacyConnectionsResourceUri,mimeType:'text/html;profile=mcp-app',
        text:CONNECTIONS_PANEL_HTML,
        _meta:{
          ui:{prefersBorder:true,csp:{connectDomains:[],
            resourceDomains:[...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[]),'https://lh3.googleusercontent.com']}},
          'openai/widgetCSP':{redirect_domains:[
            'https://github.com','https://accounts.google.com',
            ...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[]),
          ]},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']},
        },
      }]}),
    );


    // Cached MCP Apps tool metadata can still request a previous resource
    // after deployment. Keep v10-v12 URIs fetchable so ChatGPT doesn't display
    // "App unavailable" when it has cached an old Connections/Home template.
    // Each alias serves the current UI, with the requested URI in the response.
    for (const version of [10,11,12,13,14,15]) {
      for (const item of [
        {label:CONNECTIONS_PANEL_LABEL,uri:CONNECTIONS_PANEL_URI,html:CONNECTIONS_PANEL_HTML},
        {label:CONNECTIONS_HOME_LABEL,uri:CONNECTIONS_HOME_URI,html:CONNECTIONS_HOME_HTML},
      ]) {
        const oldUri=compatibilityResourceUri(item.uri,version);
        server.registerResource(item.label+' (compatibility v'+version+')',oldUri,
          {mimeType:'text/html;profile=mcp-app'},
          async()=>({contents:[{
            uri:oldUri,mimeType:'text/html;profile=mcp-app',text:item.html,
            _meta:{
              ui:{prefersBorder:true,csp:{connectDomains:[],
                resourceDomains:[...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[]),'https://lh3.googleusercontent.com']}},
              'openai/widgetCSP':{redirect_domains:[
                'https://github.com','https://accounts.google.com',
                ...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[])]},
              'openai/ui':{availableDisplayModes:['inline','fullscreen']},
            },
          }]}),
        );
      }
    }

    // MCP Apps connection manager. It is an authenticated UI resource, NOT an
    // alternate backend API or a way to bypass per-user MCP authorization.
    server.registerResource(
      CONNECTIONS_PANEL_LABEL, CONNECTIONS_PANEL_URI,
      {mimeType:'text/html;profile=mcp-app'},
      async () => ({contents:[{
        uri:CONNECTIONS_PANEL_URI, mimeType:'text/html;profile=mcp-app',
        text:CONNECTIONS_PANEL_HTML,
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[]),'https://lh3.googleusercontent.com']}},
          'openai/widgetCSP':{redirect_domains:[
            'https://github.com','https://accounts.google.com',
            ...(CONNECTIONS_PANEL_BRAND_ORIGIN ? [CONNECTIONS_PANEL_BRAND_ORIGIN] : []),
          ]},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
      }]}),
    );

    server.registerResource(
      CONNECTIONS_HOME_LABEL, CONNECTIONS_HOME_URI,
      {mimeType:'text/html;profile=mcp-app'},
      async () => ({contents:[{
        uri:CONNECTIONS_HOME_URI, mimeType:'text/html;profile=mcp-app',
        text:CONNECTIONS_HOME_HTML,
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[...(CONNECTIONS_PANEL_BRAND_ORIGIN?[CONNECTIONS_PANEL_BRAND_ORIGIN]:[]),'https://lh3.googleusercontent.com']}},
          'openai/widgetCSP':{redirect_domains:[
            'https://github.com','https://accounts.google.com',
            ...(CONNECTIONS_PANEL_BRAND_ORIGIN ? [CONNECTIONS_PANEL_BRAND_ORIGIN] : []),
          ]},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
      }]}),
    );

    // Separate read-only cross-profile *view*, assembled by ChatGPT from
    // independently authenticated profile snapshots. It never accesses
    // credentials belonging to another OAuth principal in the current call.
    server.registerResource('NestNyx Multi-account Viewer',ACCOUNT_VIEW_URI,
      {mimeType:'text/html;profile=mcp-app'},
      async()=>({contents:[{
        uri:ACCOUNT_VIEW_URI,mimeType:'text/html;profile=mcp-app',
        text:ACCOUNT_VIEW_HTML,
        _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
          'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
      }]}));


    // Cached ChatGPT tool metadata may still reference v2 or v3. Both old
    // resource URIs serve the current display-only dropdown, never OAuth grants.
    for(const version of [2,3]){
      const legacy=ACCOUNT_VIEW_URI.replace(/\/multi-v4\.html$/, '/multi-v'+version+'.html');
      if(legacy===ACCOUNT_VIEW_URI)throw new Error('NYX_ACCOUNT_VIEW_COMPAT_URI_INVALID');
      server.registerResource('NestNyx Multi-account Viewer (compatibility v'+version+')',legacy,
        {mimeType:'text/html;profile=mcp-app'},
        async()=>({contents:[{
          uri:legacy,mimeType:'text/html;profile=mcp-app',
          text:ACCOUNT_VIEW_HTML,
          _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
            'openai/ui':{availableDisplayModes:['inline','fullscreen']}},
        }]}));
    }

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
            ? (publicTenantMegaOnly()
              ? [{id:'mega',availability:'isolated_read_only_pilot'}]
              : [{id:'mega',availability:'isolated_read_only_pilot'},
                 {id:'google-drive',availability:'isolated_read_only_pilot'}]) : [])],
        note:'GitHub authorization is required. Refresh ChatGPT plugin discovery after deployment.',
      };
    });

    // OpenAI plugin multi-account discovery. One stable opaque profile per
    // validated OAuth principal; never use mutable email or client UI selections.
    server.registerTool('get_profile',{
      title:'Get my NestNyx profile',
      description:'Read the verified profile for these OAuth credentials. Stable per account; never returns another account or credentials.',
      inputSchema:z.object({}),
      outputSchema:z.object({
        id:z.string().min(1),
        name:z.string().optional(),
        email:z.string().email().optional(),
        nickname:z.string().optional(),
      }).strict(),
      _meta:{'openai/profile':true},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>{
      try {
        const owner=this.connectorOwner();
        const signed=this.signedDisplayContext.getStore();
        const hash=createHash('sha256').update('nestnyx-profile-v1:'+owner).digest('hex');
        const profile={
          id:'prf_'+hash.slice(0,32),
          ...(signed?.name?{name:signed.name}:{}),
          ...(signed?.email?{email:signed.email}:{}),
          nickname:'NestNyx account '+hash.slice(0,8),
        };
        return {structuredContent:profile,
          content:[{type:'text' as const,text:JSON.stringify(profile)}]};
      } catch {
        return {isError:true,
          content:[{type:'text' as const,text:'CONNECTOR_OWNER_REQUIRED'}]};
      }
    });

    const privateVirtualRemotesEnabled =
      process.env.NYX_DEPLOYMENT_MODE==='public' &&
      process.env.NYX_PUBLIC_CONNECTORS_ENABLED==='true' &&
      process.env.NYX_MULTIUSER_RCLONE_ENABLED==='true' &&
      process.env.NYX_PRIVATE_OWNER_LINK_ENABLED==='true' &&
      process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED==='true';

    // Never trust the display-selected Google account or a supplied connection
    // ID as an authorization grant. Re-verify the exact authenticated owner,
    // immutable OIDC owner link and private broker allowlist for EACH request.
    const privateRemotesForOwner=async(ownerId:string):Promise<ApprovedPrivateRemote[]>=>{
      if(!privateVirtualRemotesEnabled)return [];
      const link=await this.ownerLink.status(ownerId);
      if(!link.eligible||!link.linked)return [];
      const result=await this.privateBroker.connections(ownerId);
      if(!result || !('connections' in result) || !Array.isArray(result.connections))
        throw Error('PRIVATE_BROKER_RESPONSE_INVALID');
      return result.connections;
    };
    const privateRemoteById=async(ownerId:string,id:string)=>{
      const available=await privateRemotesForOwner(ownerId);
      return findPrivateRemote(ownerId,id,available,
        process.env.NYX_PRIVATE_BROKER_SHARED_KEY_B64||'');
    };

    // The model obtains one short-lived, signed nonsecret snapshot under EACH
    // OAuth link_id, then renders both in one panel. Profile tab selection is
    // display-only and has no authority to switch OAuth or mutate a connection.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
        process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true') {
      server.registerTool('nyx_account_view_snapshot',{
        title:'Snapshot my current Google account storage for side-by-side viewing',
        description:'Read only this authenticated Google login\'s public storage names, status and effective permissions; return a signed three-minute display snapshot, never credentials. Invoke separately for each linked ChatGPT account.',
        inputSchema:z.object({}),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async()=>this.safeTool(async()=>{
        const owner=this.connectorOwner();
        const signed=this.signedDisplayContext.getStore();
        const hint=createHash('sha256').update(owner).digest('hex').slice(0,10);
        const label=signed?.email||signed?.name||'Google account '+hint;
        const publicConnections=await this.connections.listStorage(owner);
        const linkedRemotes=await privateRemotesForOwner(owner);
        const key=process.env.NYX_PRIVATE_BROKER_SHARED_KEY_B64||'';
        const connections=[...publicConnections,
          ...linkedRemotes.map(remote=>privateRemoteView(owner,remote,key))];
        const filtered=(caps:string[])=>caps.filter(c=>
          ['storage:list','storage:write','storage:move','storage:delete'].includes(c));
        const token=signStorageView(owner,label,connections.map(c=>({
          displayName:c.displayName,provider:c.provider as 'mega'|'google-drive',
          status:c.status as 'pending'|'active'|'revoked',
          selected:filtered(c.capabilities),
          providerVerified:filtered(c.providerCapabilities),
          resourceCount:c.resources?.length??0,
        })),process.env.NYX_STORAGE_ENCRYPTION_KEY||'');
        return {schema:'nyx.account-view.export.v1',
          snapshot:token,expiresInSeconds:180,ownerHint:hint,
          connectionCount:connections.length,
          warning:'Read-only, signed, temporary display metadata. Not a bearer grant to any storage provider.'};
      }));
      server.registerTool('nyx_accounts_view',{
        title:'Switch between authenticated NestNyx Google accounts in one dropdown',
        description:'Open one read-only Connections viewer with a Switch account email dropdown from separately signed, unexpired Google OAuth snapshots. Never switches OAuth identity, grants sharing or accepts credentials. First invoke nyx_account_view_snapshot separately under each authenticated ChatGPT account.',
        inputSchema:z.object({accounts:z.array(z.object({
          label:z.string().min(1).max(40),
          snapshot:z.string().min(100).max(10100),
        }).strict()).min(2).max(4)}).strict(),
        _meta:{ui:{resourceUri:ACCOUNT_VIEW_URI,visibility:['model','app']},
          'openai/outputTemplate':ACCOUNT_VIEW_URI},
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async({accounts})=>this.safeTool(async()=>{
        const key=process.env.NYX_STORAGE_ENCRYPTION_KEY||'';
        const snapshots=accounts.map(a=>({label:a.label,...verifyStorageView(a.snapshot,key)}));
        const distinct=new Set(snapshots.map(a=>a.ownerHint));
        if(distinct.size!==snapshots.length)
          throw new Error('NYX_ACCOUNT_VIEW_DUPLICATE_OWNER');
        const current=createHash('sha256').update(this.connectorOwner()).digest('hex').slice(0,16);
        if(!distinct.has(current))throw new Error('NYX_ACCOUNT_VIEW_CALLER_NOT_INCLUDED');
        return {schema:'nyx.account-view.viewer.v1',
          accounts:snapshots,readOnly:true,noCrossTenantAuthorization:true,
          note:'Each record is an authenticated, signed read-only display snapshot. Operations must select the original owner OAuth connection.'};
      }));
    }

    // Display identity is derived from a signed OAuth token; the caller cannot
    // select an owner ID or switch tenants by choosing a storage connection.
    server.registerTool('nyx_session_info',{
      title:'Show my signed-in NestNyx account',
      description:'Show the current verified OAuth identity and effective storage write feature status. Read-only, current user only; no raw subject or credentials.',
      inputSchema:z.object({}),
      _meta:{ui:{visibility:['app']}},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(()=>{
      const owner=this.connectorOwner();
      const signed=this.signedDisplayContext.getStore();
      const subjectHint=createHash('sha256').update(owner).digest('hex').slice(0,10);
      return {
        authenticated:true,
        provider:process.env.NYX_DEPLOYMENT_MODE==='public'?'Google OAuth':'OAuth',
        accountHint:subjectHint,
        email:signed?.email||null,
        displayName:signed?.name||null,
        pictureUrl:signed?.picture||null,
        storageWriteAvailable:process.env.NYX_DEPLOYMENT_MODE==='public' &&
          process.env.NYX_PUBLIC_CONNECTORS_ENABLED==='true' &&
          process.env.NYX_MULTIUSER_RCLONE_ENABLED==='true' &&
          (process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true' ||
           process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED==='true'),
        sessionSwitchRequiresReconnect:true,
      };
    }));
    
    server.registerTool('nyx_connections_panel',{
      title:CONNECTIONS_PANEL_LABEL,
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
      title:CONNECTIONS_HOME_LABEL,
      description:'Open authenticated NestNyx Connections from the sidebar. Isolated storage onboarding appears only in the separately deployed public tenant pilot; no credentials are entered in ChatGPT.',
      inputSchema:z.object({}),
      _meta:{
        ui:{resourceUri:CONNECTIONS_HOME_URI,visibility:['model','app']},
        'openai/ui':{entrypoints:[{type:'global'}]},
        'openai/outputTemplate':CONNECTIONS_HOME_URI,
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

    server.registerTool('nyx_connection_github_grants_refresh',{
      title:'Refresh verified GitHub App installation permissions',
      description:'Recheck existing installation identity and actual GitHub provider grants. Does not change selected capabilities or repository boundaries.',
      inputSchema:z.object({id:z.string().uuid()}),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.githubApp.refreshInstallationGrants(this.connectorOwner(),id))));

    server.registerTool('nyx_connection_github_rulesets',{
      title:'List GitHub repository protection rulesets',
      description:'Read-only repository-scoped ruleset listing. Requires verified GitHub Administration read permission.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.rulesets(this.connectorOwner(),id,repo))));

    server.registerTool('nyx_connection_github_ruleset',{
      title:'Inspect an exact GitHub protection ruleset',
      description:'Read-only ruleset detail by integer ID. No settings are changed.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),rulesetId:z.number().int().positive()}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,rulesetId})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.ruleset(this.connectorOwner(),id,repo,rulesetId))));

    server.registerTool('nyx_connection_github_classic_protection',{
      title:'Inspect classic protection for a GitHub branch',
      description:'Read-only classic branch protection; an unprotected branch reports protected:false.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),branch:z.string().min(1).max(120)}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,branch})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.github.classicProtection(this.connectorOwner(),id,repo,branch))));

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
      }, async () => this.safeTool(async () => {
        const ownerId=this.connectorOwner();
        const ordinary=await this.connections.listStorage(ownerId);
        const remotes=await privateRemotesForOwner(ownerId);
        if(!remotes.length)return ordinary;
        const key=process.env.NYX_PRIVATE_BROKER_SHARED_KEY_B64||'';
        return [...ordinary,...remotes.map(remote=>privateRemoteView(ownerId,remote,key))];
      }));

      server.registerTool('nyx_storage_connection_create', {
        title: 'Add a separate storage connection',
        description: 'Create a pending owner-specific Google Drive or MEGA connection without provider grants or secret input. Provider sign-in is required separately.',
        inputSchema: z.object({provider: z.enum(['google-drive', 'mega']), name: z.string().min(1).max(80)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
      }, async ({provider,name}) => this.safeTool(() =>
        this.connections.createStorage(this.connectorOwner(),provider,name)));

      server.registerTool('nyx_storage_connection_rename', {
        title:'Rename my own Google Drive or MEGA connection',
        description:'Change this connection label only. Imported and OAuth connections behave identically. Credentials, provider identity, roots, and grants remain untouched.',
        inputSchema:z.object({id:z.string().uuid(),name:z.string().min(1).max(80)}).strict(),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async({id,name})=>this.safeTool(()=>
        this.connections.renameStorage(this.connectorOwner(),id,name)));

      server.registerTool('nyx_storage_connection_permissions', {
        title: 'Select storage connection capabilities',
        description: 'Select separately authorized Google Drive write/move/trash or MEGA move/trash grants. Actual provider permissions and per-root grants are enforced.',
        inputSchema: z.object({id: z.string().uuid(),
           capabilities: z.array(z.enum(['storage:list','storage:write','storage:move','storage:delete'])).max(4)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
      }, async ({id,capabilities}) => this.safeTool(() =>
        this.connections.storagePermissions(this.connectorOwner(),id,capabilities)));

      server.registerTool('nyx_storage_connection_roots', {
        title: 'Set exact storage root boundaries',
        description: 'Select explicit Drive folder ID or MEGA relative-root; never provide rclone remote names or credentials.',
        inputSchema: z.object({id:z.string().uuid(),resources:z.array(z.object({
          kind:z.enum(['drive','mega-root']),
          id:z.string().min(1).max(256),
          capabilities:z.array(z.enum(['storage:list','storage:write','storage:move','storage:delete'])).min(1).max(4),
        }).strict()).max(10)}),
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
      }, async ({id,resources}) => this.safeTool(() =>
        this.connections.storageResources(this.connectorOwner(),id,resources as ConnectorResourceRule[])));

      server.registerTool('nyx_storage_connection_begin_google', {
        title:'Authorize Google Drive for one NestNyx connection',
        description:'Generate an owner-bound Google OAuth PKCE URL with explicit read or full-drive consent. Full access still requires per-root grants.',
        inputSchema:z.object({id:z.string().uuid(),folderId:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),access:z.enum(['read','read-write']).optional()}),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
      },async({id,folderId,access})=>this.safeTool(()=>
        this.tenantGoogle.begin(this.connectorOwner(),id,folderId,access||'read')));

      server.registerTool('nyx_storage_connection_begin_mega', {
        title:'Open a secure MEGA account sign-in form',
        description:'Create an expiring HTTPS link for MEGA sign-in. Enter passwords ONLY on the first-party NestNyx page, never in ChatGPT. Does not ask to disable 2FA.',
        inputSchema:z.object({id:z.string().uuid(),rootPath:z.string().min(1).max(256)}),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
      },async({id,rootPath})=>this.safeTool(()=>
        this.tenantMega.begin(this.connectorOwner(),id,rootPath)));

      // Only a signed owner can obtain a short-lived first-party upload link.
      // Never accept local Rclone credential bytes in MCP arguments.
      if (process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED === 'true') {
        server.registerTool('nyx_storage_connection_begin_import', {
          title:'Import my local Rclone file via secure HTTPS',
          description:'Owner-bound one-time HTTPS link for selecting one remote from a local Rclone file. Do not send file contents or secrets to ChatGPT.',
          inputSchema:z.object({id:z.string().uuid()}).strict(),
          annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
        },async({id})=>this.safeTool(()=>
          this.tenantRcloneUpload.begin(this.connectorOwner(),id)));
      }

      if (process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED === 'true') {
        server.registerTool('nyx_storage_connection_begin_import_all', {
          title:'Import all my local Rclone connections',
          description:'One-time owner-bound HTTPS file upload. Automatically import all supported Google Drive and MEGA remotes; no file contents or credentials in MCP. Existing connections are preserved.',
          inputSchema:z.object({}).strict(),
          annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
        },async()=>this.safeTool(()=>
          this.tenantRcloneUpload.beginAll(this.connectorOwner())));
      }

      if (process.env.NYX_PUBLIC_RCLONE_FILE_IMPORT_ENABLED === 'true') {
        server.registerTool('nyx_storage_connection_finish_import', {
          title:'Activate an already read-verified imported Rclone connection (read-only)',
          description:'Only for a pending connection owned by the current OAuth identity after a successful, fresh and independently attested provider read. Atomically activates storage:list only.',
          inputSchema:z.object({id:z.string().uuid()}).strict(),
          annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
        },async({id})=>this.safeTool(()=>
          this.tenantRclone.activateImportedReadOnly(this.connectorOwner(),id)));
      }

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
        description:'Read-only: lists up to 100 names within the exact owner-authorized root using an isolated per-connection Rclone config. Separate gated tools govern changes.',
        inputSchema:z.object({
          id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
          rootId:z.string().min(1).max(256),
          path:z.string().max(2048).optional(),
        }),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      },async({id,provider,rootId,path})=>this.safeTool(async()=>{
        const ownerId=this.connectorOwner();
        const remote=await privateRemoteById(ownerId,id);
        if(remote) {
          if(provider!==remote.provider || rootId!==PRIVATE_REMOTE_ROOT)
            throw Error('TENANT_RCLONE_CONNECTION_FORBIDDEN');
          const result=await this.privateBroker.listRemote(ownerId,remote.name,path||'');
          if(!('entries' in result)||!Array.isArray(result.entries))
            throw Error('PRIVATE_BROKER_RESPONSE_INVALID');
          return {items:result.entries.map(e=>({path:e.name,isDir:e.isDir,size:e.size})),
            truncated:result.entries.length===100,readOnly:true,
            source:'private-pro-broker'};
        }
        return this.tenantRclone.listAuthorizedRoot(
          ownerId,id,provider,rootId,path||'');
      }));


      if (process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED === 'true') {
        // No extra click-by-click confirmation. Permissions are independently
        // selected per verified MEGA account, and deletion uses MEGA rubbish bin.
        server.registerTool('nyx_storage_mega_file_mutate', {
          title:'Rename, move, or trash one file in my MEGA account',
          description:'Single-file action under one exact owner-authorized MEGA root. Trash uses MEGA rubbish bin; no permanent deletion. Never accepts owner IDs or remote names.',
          inputSchema:z.object({
            id:z.string().uuid(),rootId:z.string().min(1).max(256),
            operation:z.enum(['rename','move','trash']),
            sourcePath:z.string().min(1).max(2048),
            destinationPath:z.string().max(2048).optional(),
          }).strict(),
          annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
        },async({id,rootId,operation,sourcePath,destinationPath})=>this.safeTool(()=>
          this.tenantRclone.mutateMegaFile(this.connectorOwner(),id,rootId,
            operation,sourcePath,destinationPath)));
      }

      if(process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED==='true') {
        server.registerTool('nyx_storage_google_verify_rw', {
          title:'Verify existing imported Google Drive credentials for RW',
          description:'Provider-side read-only tokeninfo and Drive account check. Upgrades provider-verified capabilities only when the stored active token really has full Drive scope. User-selected permissions are unchanged.',
          inputSchema:z.object({id:z.string().uuid(),rootId:z.string().min(1).max(256)}).strict(),
          annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
        },async({id,rootId})=>this.safeTool(()=>
          this.tenantRclone.verifyExistingGoogleWriteGrant(this.connectorOwner(),id,rootId)));
      }

      if (process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED === 'true') {
        server.registerTool('nyx_storage_google_file_mutate', {
          title:'Rename, move, or trash one file in my verified Google Drive root',
          description:'Owner-bound single-file rename, move or recoverable Trash. Requires verified full Drive OAuth scope and per-root grants. No permanent deletion.',
          inputSchema:z.object({
            id:z.string().uuid(),rootId:z.string().min(1).max(256),
            operation:z.enum(['rename','move','trash']),
            sourcePath:z.string().min(1).max(2048),
            destinationPath:z.string().max(2048).optional(),
          }).strict(),
          annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
        },async({id,rootId,operation,sourcePath,destinationPath})=>this.safeTool(()=>
          this.tenantRclone.mutateGoogleFile(this.connectorOwner(),id,rootId,
            operation,sourcePath,destinationPath)));
      }

      if(process.env.NYX_PUBLIC_GOOGLE_WRITE_ENABLED==='true' ||
         process.env.NYX_PUBLIC_MEGA_WRITE_ENABLED==='true') {
        server.registerTool('nyx_storage_text_file_create', {
          title:'Create a new UTF-8 text file in my verified cloud root',
          description:'One bounded text file, without overwriting. Requires owner, verified provider, selected storage:write grant, root authorization, and provider RW permission. Does not provide binary uploads.',
          inputSchema:z.object({
            id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
            rootId:z.string().min(1).max(256),
            path:z.string().min(1).max(2048),
            content:z.string().max(65536),
          }).strict(),
          annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
        },async({id,provider,rootId,path,content})=>this.safeTool(()=>
          this.tenantRclone.createTenantTextFile(this.connectorOwner(),id,provider,rootId,path,content)));
      }

      if(process.env.NYX_PUBLIC_TRASH_CLEANUP_ENABLED==='true') {
        server.registerTool('nyx_storage_trash_cleanup',{
          title:'Preview or permanently empty my provider account Trash',
          description:'Account-wide irreversible cleanup; not folder scoped. Omitting confirmed returns a no-write safety preview. Set confirmed=true only for an explicit authorized cleanup request. The provider may finish asynchronously.',
          inputSchema:z.object({
            id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
            rootId:z.string().min(1).max(256),confirmed:z.boolean().default(false),
          }).strict(),
          annotations:{readOnlyHint:false,destructiveHint:true,
            idempotentHint:false,openWorldHint:true},
        },async({id,provider,rootId,confirmed})=>this.safeTool(()=>
          this.tenantRclone.cleanupTenantTrash(
            this.connectorOwner(),id,provider,rootId,confirmed)));
      }

      server.registerTool('nyx_storage_connection_select_best', {
        title:'Select my strongest verified cloud connection for an operation',
        description:'Read-only choice among active connections within the same verified OAuth owner, physical provider identity and exact authorized root. Does not transfer credentials or execute the operation.',
        inputSchema:z.object({
          id:z.string().uuid(),rootId:z.string().min(1).max(256),
          operation:z.enum(['storage:list','storage:write','storage:move','storage:delete']),
          path:z.string().max(2048).optional(),
        }).strict(),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async({id,rootId,operation,path})=>this.safeTool(()=>
        this.tenantRclone.selectBestAuthorizedConnection(
          this.connectorOwner(),id,rootId,operation,path)));

      server.registerTool('nyx_storage_connection_revoke', {
        title:'Revoke my MEGA or Google Drive connection',
        description:'Owner-scoped: revoke this tenant storage grant and erase its pending/active encrypted credentials and unconsumed sign-in links. Does not revoke provider-side sessions or touch private/operator Rclone config.',
        inputSchema:z.object({id:z.string().uuid()}),
        annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
      },async({id})=>this.safeTool(() =>
        this.tenantRclone.revokeStorage(this.connectorOwner(),id)));

      server.registerTool('nyx_storage_connection_test_active', {
        title: 'Verify read access to my active isolated storage root',
        description: 'Read-only Rclone probe using only the authenticated owner, one activated connection and its exact selected root. Never uses private global Rclone configuration or returns file names.',
        inputSchema: z.object({
          id:z.string().uuid(),provider:z.enum(['google-drive','mega']),
          rootId:z.string().min(1).max(256),
          path:z.string().max(2048).optional(),
        }),
        annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      }, async ({id,provider,rootId,path}) => this.safeTool(async()=>{
        const ownerId=this.connectorOwner();
        const remote=await privateRemoteById(ownerId,id);
        if(remote) {
          if(provider!==remote.provider || rootId!==PRIVATE_REMOTE_ROOT)
            throw Error('TENANT_RCLONE_CONNECTION_FORBIDDEN');
          await this.privateBroker.listRemote(ownerId,remote.name,path||'');
          return 'verified';
        }
        return this.tenantRclone.probeAuthorizedRoot(
          ownerId,id,provider,rootId,path || '');
      }));
    }

    // Isolated, owner-bound HEROKU read-only metadata bridge (OFF by default).
    // No Heroku bearer token may be present in this NestNyx runtime; only a
    // separate read-scoped broker owns that token. The broker separately checks
    // the exact owner + connection + app, and hard-codes GET endpoints.
    if (process.env.NYX_HEROKU_READ_ENABLED === 'true') {
      server.registerTool('nyx_heroku_app_info', {
        title:'Read approved Heroku app metadata',
        description:'Read only name, region and app URL from an independent read-scoped broker. No config values, log drains, billing, writes or deploys.',
        inputSchema:z.object({app:z.string().regex(/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/)}),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      },async({app})=>this.safeTool(async()=>{
        const scope=herokuReadAuthorization(this.connectorOwner(),app);
        return this.herokuBroker.appInfo(scope.ownerId,scope.connectionId,scope.app);
      }));
      server.registerTool('nyx_heroku_releases', {
        title:'Read approved Heroku release versions',
        description:'Read at most 50 sanitized release IDs/versions/timestamps. No release output, config values, logs, billing or deployment actions.',
        inputSchema:z.object({app:z.string().regex(/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/)}),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      },async({app})=>this.safeTool(async()=>{
        const scope=herokuReadAuthorization(this.connectorOwner(),app);
        return this.herokuBroker.releases(scope.ownerId,scope.connectionId,scope.app);
      }));
    }

    // Identity-only owner linking is gated behind a separate public pilot flag.
    // It never exposes a legacy remote or hands off a private Rclone credential.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
        process.env.NYX_PRIVATE_OWNER_LINK_ENABLED === 'true') {
      server.registerTool('nyx_private_owner_link_status', {
        title:'Check whether my private owner identity is linked',
        description:'Eligibility for a separate Google owner-link only. Never returns identities, secrets or private Rclone remotes. A linked identity does not yet grant broker access.',
        inputSchema:z.object({}),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async()=>this.safeTool(()=>this.ownerLink.status(this.connectorOwner())));
      server.registerTool('nyx_private_owner_link_begin', {
        title:'Verify my approved Google identity for private Rclone ownership',
        description:'Start a one-time Google OIDC identity-only sign-in for the operator-approved MCP owner. Does not request Google Drive access or expose existing Rclone credentials.',
        inputSchema:z.object({}),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
      },async()=>this.safeTool(()=>this.ownerLink.begin(this.connectorOwner())));
    }

    // Narrow broker tools are public-pilot-only and independently owner-linked.
    // No provider credential, global remote name or general Rclone command crosses
    // the public/private boundary. Both deployments must opt in separately.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true' &&
        process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true' &&
        process.env.NYX_PRIVATE_OWNER_LINK_ENABLED === 'true' &&
        process.env.NYX_PRIVATE_BROKER_CLIENT_ENABLED === 'true') {
      server.registerTool('nyx_private_legacy_roots', {
        title:'List my approved private storage roots',
        description:'Owner-only signed read of explicitly approved private root aliases; never reveals Rclone configuration or credentials.',
        inputSchema:z.object({}),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async()=>this.safeTool(()=>this.privateBroker.roots(this.connectorOwner())));
      server.registerTool('nyx_private_legacy_list', {
        title:'List files inside my approved private storage root',
        description:'Owner-only read of at most 100 entries under one server-allowlisted root. No writes, arbitrary remote names or raw credentials.',
        inputSchema:z.object({root:z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
          path:z.string().max(1024).optional()}).strict(),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      },async({root,path})=>this.safeTool(()=>
        this.privateBroker.list(this.connectorOwner(),root,path||'')));
    }

    // Public multi-user connector mode deliberately omits all legacy global
    // storage roots, Rclone, NYX CLI commands and cross-user private handoffs.
    // KEY uses only caller-supplied messages; it has no access to ChatGPT's
    // hidden transcript. Public tenants must never access private MAIN keys.
    const chatMessageSchema = z.object({
      role:z.enum(['user','assistant']),
      text:z.string().min(1).max(6000),
      id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    }).strict();
    const chatMessagesSchema = z.array(chatMessageSchema).min(1).max(80);
    server.registerTool('nyx_key_extract_preview',{
      title:'Preview actionable KEY signals from supplied chat messages',
      description:'Read-only extractor for authenticated users; accepts only explicitly supplied bounded chat text. User instructions only; no ChatGPT transcript access, storage writes, seed or canonical changes.',
      inputSchema:z.object({messages:chatMessagesSchema}).strict(),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async({messages})=>this.safeTool(async()=>{
      this.connectorOwner();
      return extractKeySignals(messages);
    }));
    server.registerTool('nyx_key_stage',{
      title:'Stage verified KEY oF or pending oS seed proposal',
      description:'Owner-isolated staging only. Public mode stores in tenant-specific Neon rows, never private MAIN. oF creates immutable temp-key transaction receipts, no seed. oS additionally creates pending-validation seed proposals. Public tenant writes require DATABASE_URL and may be disabled with NYX_KEY_TENANT_ENABLED=false; private requires NYX_KEY_MCP_ENABLED=true; never rewrites canonical bundles or promotes seeds.',
      inputSchema:z.object({
        stage:z.enum(['oF','oS']),
        scope:z.enum(['local','global']).default('local'),
        transactionId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        messages:chatMessagesSchema,
      }).strict(),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },async({stage,scope,transactionId,messages})=>this.safeTool(async()=>{
      this.connectorOwner();
      const publicTenant=process.env.NYX_DEPLOYMENT_MODE==='public';
      if (!publicTenant && process.env.NYX_KEY_MCP_ENABLED!=='true')
        throw Error('KEY_ENDPOINT_DISABLED_PENDING_AUTH_AND_CANONICAL_VALIDATION');
      const extracted=extractKeySignals(messages);
      if(!extracted.candidates.length)throw Error('KEY_NO_GROUNDED_CANDIDATES');
      const candidates=extracted.candidates.map(({evidence,...candidate})=>candidate);
      const owner=this.connectorOwner();
      const staged=publicTenant
        ? await this.tenantKeys.execute(owner,{stage,scope,transactionId,candidates})
        : await this.keys.execute({stage,scope,transactionId,candidates});
      return {...staged,source:'explicit-supplied-chat',
        suppliedMessageCount:extracted.suppliedMessageCount,
        persistedCandidateCount:candidates.length,
        seedStatus:stage==='oS'?'pending_validation':'none',
        canonicalChanged:false};
    }));


    // Single-call Dev adapter for accepted pending KEY-only shorthand.
    // It uses only caller-supplied messages; it never reads private chat
    // history or changes canonical Head grammar or bundle state.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') {
      server.registerTool('nyx_key_chain',{
        title:'Execute Nyx KEY file then seed in one verified transaction',
        description:'Strict Dev KEY-only adapter: accepts Nyx key oF x oS [Go], Nyx key oFxS [Go], or explicit Nyx key oF x key oS [Go]. Executes F then S atomically in authenticated tenant-isolated Neon. oS creates pending-validation seed proposals only. Requires explicit bounded chat messages; does not access hidden ChatGPT transcript, core GEN/CAN, or private MAIN.',
        inputSchema:z.object({
          command:z.string().min(8).max(100),
          messages:chatMessagesSchema,
          transactionId:z.string().regex(/^[A-Za-z0-9_-]{1,73}$/).optional(),
        }).strict(),
        annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async({command,messages,transactionId})=>this.safeTool(async()=>{
        const owner=this.connectorOwner();
        const extracted=extractKeySignals(messages);
        if(!extracted.candidates.length)throw Error('KEY_NO_GROUNDED_CANDIDATES');
        const candidates=extracted.candidates.map(({evidence,...candidate})=>candidate);
        const result=await this.tenantKeys.executeFs(owner,{
          command,candidates,transactionId,
        });
        return {...result,source:'explicit-supplied-chat',
          suppliedMessageCount:extracted.suppliedMessageCount,
          selectedCandidateCount:candidates.length};
      }));
    }

    // Authenticated public tenants can preflight INI syntax without crossing
    // the private MAIN bootstrap boundary. Separate authorized provider reads
    // remain mandatory before anyone may claim source-verified initialization.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') {
      server.registerTool('nyx_ini_plan',{
        title:'Prepare NYX initialization for my connected sources',
        description:'Tenant-authenticated read-only preparation for Nyx ini, including GNo. Does not read private Head/Body/Footer, access operator Rclone, create a FIF or claim initialization completed. Resolve required sources separately through the user-authorized Google Drive connector.',
        inputSchema:z.object({
          target:z.string().min(1).max(1024).optional(),
          targets:z.array(z.string().min(1).max(80)).max(16).optional(),
          scope:z.enum(['local','global']).optional(),
          depth:z.enum(['basic','normal','deep']).optional(),
        }).strict(),
        annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      },async input=>this.safeTool(()=>{
        this.connectorOwner();
        return preparePublicIniPlan(input);
      }));
    }

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
    server.registerTool('nyx_maintenance_runtime_inspect',{
      title:'Inspect runtime key pins for a verified Tester revision',
      description:'Private operator maintenance: compare the fixed Tester runtime profile with live source hashes and the bootstrap CLI. No pin changes, shell, deployment or canonical-readiness claim.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        expectedTesterSha:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    },async({id,repo,expectedTesterSha})=>this.safeTool(()=>
      this.limitedConnectionApi(id,()=>this.maintenance.inspect(
        this.connectorOwner(),id,repo,expectedTesterSha))));
    server.registerTool('nyx_maintenance_runtime_prepare',{
      title:'Prepare a reviewed runtime-pin repair on a new Tester review branch',
      description:'Private operator maintenance: re-read live sources and require exact reviewed hashes, profile hash, CLI hash and Tester SHA. Only updates existing key SHA pins in config/nyx-runtime-profile.json on a new nyx/* review branch, verifies readback and opens a draft PR. No shell, merge, deployment, secret editing or core-bundle mutation.',
      inputSchema:z.object({id:z.string().uuid(),repo:z.string().min(3).max(200),
        expectedTesterSha:z.string().regex(/^[a-f0-9]{40}$/),
        reviewBranch:z.string().min(5).max(100),
        expectedProfileSha256:z.string().regex(/^[a-f0-9]{64}$/),
        expectedCliSha256:z.string().regex(/^[a-f0-9]{64}$/),
        reviewedKeys:z.array(z.object({key:z.string().min(1).max(64),
          sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(32),
      }).strict(),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    },async(input)=>this.safeTool(()=>this.limitedConnectionApi(input.id,()=>
      this.maintenance.prepare(this.connectorOwner(),input))));
    server.registerTool('nyx_head_status',{
      title:'Verify the current canonical NYX Head and CLI',
      description:'Read canonical Head/CLI version, hash and verified cache metadata from the current NYX bootstrap. Does not modify any bundle.',
      inputSchema:z.object({}),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async()=>this.safeTool(async()=>{
      this.connectorOwner();
      const locator=await this.bootstrap.locate();
      const {cli,hash}=await this.cliRegistry.current(locator);
      const preflight=await this.commands.inspectRuntimeProfile(locator,hash);
      return {
        status:preflight.ready?(('driftDetected' in preflight && preflight.driftDetected)?'BOOTSTRAP_VERIFIED_WITH_WARNINGS':'BOOTSTRAP_VERIFIED'):'NOT_READY',
        role:'constitution-library',canonical:locator.canonical,
        canonical_freshness:'bootstrap-pointer-only; newest Footer not independently checked',
        preflight,
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
