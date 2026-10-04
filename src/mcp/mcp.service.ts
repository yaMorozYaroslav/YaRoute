import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { InitService } from '../init/init.service';
import { JobStoreService } from '../storage/job-store.service';
import { StorageService } from '../storage/storage.service';
import { CopyJobPayload } from '../storage/storage.types';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    private readonly storage: StorageService,
    private readonly jobs: JobStoreService,
    private readonly init: InitService,
  ) {
    const handler = createMcpHandler(() => this.buildServer());
    this.nodeHandler = toNodeHandler(handler, {
      onerror: (error) => this.logger.error(`MCP transport error: ${error.message}`),
    });
  }

  async handle(req: Request, res: Response, parsedBody: unknown) {
    await this.nodeHandler(req, res, parsedBody);
  }

  private buildServer() {
    const server = new McpServer({
      name: 'NestNyx',
      version: '0.6.0',
    });

    server.registerTool(
      'nyx_ini',
      {
        title: 'Initialize Nyx runtime context',
        description:
          'Resolve the current Nyx bootstrap: verify canonical Head/Body/Footer, Head paths.json and nyxcli.json, live paths.md plus pending overlays, nyx_entry, Template map/index, then optionally hydrate an Area. Pending overlays remain noncanonical and initialization does not rewrite core bundles or Area state.',
        inputSchema: z.object({
          target: z.string().min(1).max(64).optional(),
          scope: z.enum(['local', 'global']).optional().default('local'),
          sessionId: z.string().uuid().optional(),
          depth: z.enum(['basic', 'normal', 'deep']).optional().default('normal'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ target, scope, sessionId, depth }) =>
        this.safeTool(() => this.init.initialize({ target, scope, sessionId, depth })),
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
      async () => this.safeTool(() => ({ areas: this.storage.areas() })),
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
          'List only logical storage aliases explicitly tagged as MEGA in NYX_SHARED_ROOTS_JSON. Remote names and credentials are not exposed.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.safeTool(() => ({ accounts: this.storage.megaAreas() })),
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      };
    }
  }
}
