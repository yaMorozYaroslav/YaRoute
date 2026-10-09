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
import { NyxBootstrapService } from '../nyx/bootstrap.service';
import { NyxCliRegistryService } from '../nyx/cli-registry.service';
import { NyxHeadLibraryService } from '../nyx/head-library.service';

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
    private readonly registry: NyxCliRegistryService,
    private readonly head: NyxHeadLibraryService,
  ) {
    const handler = createMcpHandler(() => this.buildServer());
    this.nodeHandler = toNodeHandler(handler, {
      onerror: (error) => this.logger.error(`MCP transport error: ${error.message}`),
    });
  }

  async handle(req: Request, res: Response, parsedBody: unknown) {
    await this.ownerContext.run(`oauth:${res.locals.nyxSubject}`, () => this.nodeHandler(req, res, parsedBody));
  }

  private buildServer() {
    const server = new McpServer({
      name: 'NestNyx',
      version: '0.8.0',
    });

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
      'nyx_head_status',
      {
        title: 'Inspect Nyx Head constitution library',
        description: 'Verify canonical Head CLI authority and report the read-only Head library cache used by NestNyx.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => this.safeTool(async () => {
        const locator = await this.bootstrap.locate();
        const cli = await this.registry.current(locator);
        return {
          status: 'READY',
          role: 'constitution-library',
          canonical: locator.canonical,
          cli: { version: cli.cli.version, sha256: cli.hash },
          library: this.head.snapshot(),
          source_of_truth: 'canonical Head bundle',
          mutation: 'read-only runtime cache',
        };
      }),
    );

    server.registerTool(
      'nyx_areas',
      {
        title: 'List Nyx shared areas',
        description: 'List the logical shared-folder areas that NestNyx is allowed to access.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.safeTool(async () => ({ areas: await this.storage.areas() })),
    );

    server.registerTool(
      'nyx_list',
      {
        title: 'List files in a shared area',
        description: 'List files and folders below one configured Nyx shared-folder root. Paths cannot escape the configured root.',
        inputSchema: z.object({
          area: z.string().min(1).describe('Logical shared area, for example A, B, C, or D.'),
          path: z.string().default('').describe('Relative path below the shared root. Empty string lists the root.'),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ area, path }) => this.safeTool(() => this.storage.list(area, path)),
    );

    server.registerTool(
      'nyx_stat',
      {
        title: 'Inspect a shared-area file',
        description: 'Read rclone file metadata, hashes, size, and owner for one path below a configured Nyx shared-folder root.',
        inputSchema: z.object({
          area: z.string().min(1),
          path: z.string().min(1),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ area, path }) => this.safeTool(() => this.storage.stat(area, path)),
    );

    server.registerTool(
      'nyx_capacity',
      {
        title: 'Check storage capacity',
        description: 'Report quota total, used, and free bytes for the unique rclone accounts backing the configured shared areas.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.safeTool(() => this.storage.capacity()),
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
          message: 'Global file indexing queued. Poll nyx_job_status for completion.',
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
          message: 'Copy queued. Poll nyx_job_status until it succeeds or fails.',
        };
      }),
    );

    server.registerTool(
      'nyx_job_status',
      {
        title: 'Check a Nyx storage job',
        description: 'Read the status and verification evidence for a queued storage job.',
        inputSchema: z.object({
          id: z.string().uuid(),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => this.safeTool(async () => {
        const job = await this.jobs.get(id);
        if (!job) throw new Error('Job not found');
        return job;
      }),
    );

    return server;
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
