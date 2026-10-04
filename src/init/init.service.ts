import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RcloneService } from '../storage/rclone.service';
import { SharedRootsService } from '../storage/shared-roots.service';
import { InitSessionStoreService } from './init-session-store.service';
import { parsePathsRegistry } from './paths-registry.parser';
import {
  BundleMemberPointer,
  CorePointer,
  InitInput,
  InitReadiness,
  ParsedPathsRegistry,
} from './init.types';

type ZipEntry = { getData(): Buffer };
type ZipReader = { getEntry(name: string): ZipEntry | null };
type ZipCtor = new (filename: string) => ZipReader;
const AdmZip = require('adm-zip') as ZipCtor;

type Evidence = {
  loaded: boolean;
  path: string;
  sha256?: string;
  bytes?: number;
  error?: string;
  document?: unknown;
  summary?: Record<string, unknown>;
};

@Injectable()
export class InitService {
  constructor(
    private readonly roots: SharedRootsService,
    private readonly rclone: RcloneService,
    private readonly sessions: InitSessionStoreService,
  ) {}

  async initialize(input: InitInput = {}) {
    const scope = input.scope ?? 'local';
    const depth = input.depth ?? 'normal';
    const target = input.target?.trim() || undefined;
    if (target && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(target)) {
      throw new BadRequestException('Invalid initialization target');
    }

    const storageArea = process.env.NYX_INIT_AREA?.trim() || 'MAIN';
    const registryPath =
      process.env.NYX_PATHS_REGISTRY_PATH?.trim() ||
      'ChatGPT/1_body/1_areas_v0/NoteFlow/3_resources/SYSTEM/paths.md';

    const registryTarget = this.roots.resolve(storageArea, registryPath);
    const [{ stdout: registryMarkdown }, registryStat] = await Promise.all([
      this.rclone.run(['cat', registryTarget]),
      this.rclone.json(['lsjson', registryTarget, '--stat', '--hash']),
    ]);

    const parsed = parsePathsRegistry(registryMarkdown);
    const warnings: string[] = [];

    for (const role of ['Head', 'Body', 'Footer'] as const) {
      if (!parsed.core[role]) {
        warnings.push(`Missing canonical ${role} pointer in live paths registry`);
      }
    }
    if (!parsed.canonicalCli) {
      warnings.push('Missing canonical executable CLI pointer in live paths registry');
    }
    if (!parsed.compatibilityCommandTable) {
      warnings.push('Missing compatibility command-table pointer in live paths registry');
    }

    const head = parsed.core.Head
      ? await this.loadCoreBundle(storageArea, parsed.core.Head)
      : undefined;

    const otherCore = await Promise.all(
      (['Body', 'Footer'] as const)
        .map((role) => parsed.core[role])
        .filter((pointer): pointer is CorePointer => Boolean(pointer))
        .map((pointer) => this.verifyCore(storageArea, pointer)),
    );

    const coreVerification = [
      ...(head ? [head.verification] : []),
      ...otherCore,
    ];

    for (const verification of coreVerification) {
      if (!verification.verified) {
        warnings.push(
          `${verification.role} verification failed: ${verification.error || 'unknown error'}`,
        );
      }
    }

    let canonicalMachine: Record<string, unknown> | null = null;
    let compatibility: Record<string, unknown> | null = null;
    let headTopology: Record<string, unknown> | null = null;

    try {
      if (head?.verification.verified && head.localPath) {
        const zip = new AdmZip(head.localPath);
        const canonicalPaths = this.readJsonMember(
          zip,
          'LEAD/Core_Skills/FileFilter/paths.json',
        );
        const canonicalCli = this.readJsonPointer(
          zip,
          parsed.canonicalCli,
          'LEAD/Core_Skills/YaRoCLI/nyxcli.json',
        );
        const compatibilityTable = this.readJsonPointer(
          zip,
          parsed.compatibilityCommandTable,
          'FILE/yaro_command_table_v015.json',
        );

        canonicalMachine = {
          paths: canonicalPaths,
          cli: canonicalCli,
        };
        compatibility = compatibilityTable;

        const projectConfig = this.readOptionalJsonMember(zip, 'project_config.json');
        const projectIndex = this.readOptionalJsonMember(zip, 'project_index.json');
        const projectMap = this.readOptionalTextMember(zip, 'project_map.md');
        headTopology = {
          projectConfig,
          projectIndex,
          projectMap,
          available: Boolean(projectConfig || projectIndex || projectMap),
        };
      }
    } catch (error) {
      warnings.push(
        `Canonical Head machine-state verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (head?.localPath) fs.rmSync(head.localPath, { force: true });
    }

    const tempPaths = await this.readJsonEvidence(
      storageArea,
      this.routePath(
        parsed,
        'temp_paths',
        'YaRoute/0_repository/3_template/staging/drafts/temp_paths.json',
      ),
      true,
    );
    const tempNyxCli = await this.readJsonEvidence(
      storageArea,
      this.routePath(
        parsed,
        'temp_nyxcli',
        'YaRoute/0_repository/3_template/staging/drafts/temp_nyxcli.json',
      ),
      true,
    );
    const nyxEntry = await this.readTextEvidence(
      storageArea,
      this.routePath(
        parsed,
        'nyx_entry_temp',
        'YaRoute/0_repository/3_template/staging/drafts/temp_files/nyx_entry.md',
      ),
    );
    const templateMap = await this.readTextEvidence(
      storageArea,
      this.routePath(
        parsed,
        'template_map',
        'YaRoute/0_repository/3_template/template_map.md',
      ),
    );
    const templateIndex = await this.readJsonEvidence(
      storageArea,
      this.routePath(
        parsed,
        'template_index',
        'YaRoute/0_repository/3_template/template_index.json',
      ),
      false,
    );

    for (const [name, evidence] of [
      ['temp_paths.json', tempPaths],
      ['temp_nyxcli.json', tempNyxCli],
      ['nyx_entry.md', nyxEntry],
      ['template_map.md', templateMap],
      ['template_index.json', templateIndex],
    ] as const) {
      if (!evidence.loaded) {
        warnings.push(`Required bootstrap source ${name} failed: ${evidence.error}`);
      }
    }

    const visibleSources = await this.loadVisibleSources(
      storageArea,
      parsed,
      depth,
    );
    for (const [name, evidence] of Object.entries(visibleSources)) {
      if (!(evidence as Evidence).loaded) {
        warnings.push(
          `Visible initialization source ${name} failed: ${(evidence as Evidence).error}`,
        );
      }
    }

    let areaHydration: unknown = undefined;
    if (target) {
      const pointer = parsed.areas[target];
      if (!pointer) {
        warnings.push(`Target Area ${target} is not present in Operational Area routing`);
      } else {
        areaHydration = await this.hydrateArea(
          storageArea,
          target,
          pointer,
          warnings,
        );
      }
    }

    const coreReady =
      coreVerification.length === 3 &&
      coreVerification.every((item) => item.verified);
    const canonicalMachineReady = Boolean(
      canonicalMachine &&
        (canonicalMachine.paths as any)?.verified &&
        (canonicalMachine.cli as any)?.verified &&
        (compatibility as any)?.verified,
    );
    const bootstrapReady = [
      tempPaths,
      tempNyxCli,
      nyxEntry,
      templateMap,
      templateIndex,
    ].every((item) => item.loaded);

    const visibleReady = Object.values(visibleSources).every(
      (item) => (item as Evidence).loaded,
    );
    const mandatoryReady =
      coreReady && canonicalMachineReady && bootstrapReady && visibleReady;
    const readiness: InitReadiness = !mandatoryReady
      ? 'NOT_READY'
      : warnings.length
        ? 'READY_WITH_WARNINGS'
        : 'READY';

    const receipt = {
      schema: 'nyx.initialization.receipt.v2',
      initializedAt: new Date().toISOString(),
      readiness,
      scope,
      depth,
      target: target ?? null,
      authoritySource: 'drive',
      authority: {
        registry: {
          area: storageArea,
          path: registryPath,
          stat: registryStat,
          sha256: this.sha256(registryMarkdown),
        },
        core: parsed.core,
        coreVerification,
        canonicalCli: parsed.canonicalCli ?? null,
        compatibilityCommandTable: parsed.compatibilityCommandTable ?? null,
        canonicalMachine,
        compatibility,
      },
      bootstrap: {
        order: [
          'nyx_entry',
          'canonical paths.json + live paths.md + temp_paths overlay',
          'canonical nyxcli.json + temp_nyxcli overlay',
          'template_map.md + template_index.json',
          'project topology when canonicalized/available',
          'command/Area-required sources',
          'execute',
          'verify',
          'report',
        ],
        nyxEntry,
        tempPaths,
        tempNyxCli,
        templateMap,
        templateIndex,
        projectTopology: headTopology,
        pendingOverlaysRemainNoncanonical: true,
      },
      visibleSources,
      area: areaHydration ?? null,
      warnings,
      mutation: {
        coreBundlesChanged: false,
        areaStateChanged: false,
        sessionStateOnly: true,
      },
    };

    const session = await this.sessions.upsert(
      input.sessionId,
      target,
      scope,
      receipt,
    );

    return {
      ...receipt,
      session: {
        id: session.id,
        durable: this.sessions.isDurable(),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    };
  }

  private async loadCoreBundle(area: string, pointer: CorePointer) {
    const storagePath = this.repositoryPathToStoragePath(pointer.repositoryPath);
    const target = this.roots.resolve(area, storagePath);
    const tempFile = path.join(
      os.tmpdir(),
      `nyx-${pointer.role.toLowerCase()}-${process.pid}-${Date.now()}.zip`,
    );

    try {
      const stat = await this.rclone.json(['lsjson', target, '--stat', '--hash']);
      await this.rclone.run(['copyto', target, tempFile]);
      const actualSha256 = this.sha256(fs.readFileSync(tempFile));
      const hashMatch = pointer.expectedSha256
        ? actualSha256 === pointer.expectedSha256
        : null;

      return {
        localPath: tempFile,
        verification: {
          role: pointer.role,
          verified: hashMatch !== false,
          repositoryPath: pointer.repositoryPath,
          storagePath,
          expectedDriveId: pointer.driveId,
          expectedSha256: pointer.expectedSha256 ?? null,
          actualSha256,
          hashMatch,
          stat,
        },
      };
    } catch (error) {
      fs.rmSync(tempFile, { force: true });
      return {
        localPath: undefined,
        verification: {
          role: pointer.role,
          verified: false,
          repositoryPath: pointer.repositoryPath,
          storagePath,
          expectedDriveId: pointer.driveId,
          expectedSha256: pointer.expectedSha256 ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async verifyCore(area: string, pointer: CorePointer) {
    const loaded = await this.loadCoreBundle(area, pointer);
    if (loaded.localPath) fs.rmSync(loaded.localPath, { force: true });
    return loaded.verification;
  }

  private readJsonPointer(
    zip: ZipReader,
    pointer: BundleMemberPointer | undefined,
    fallbackMember: string,
  ) {
    const member = this.memberFrom(pointer?.bundlePath) || fallbackMember;
    const result = this.readJsonMember(zip, member);
    if (
      result.verified &&
      pointer?.expectedSha256 &&
      result.sha256 !== pointer.expectedSha256
    ) {
      return {
        ...result,
        verified: false,
        expectedSha256: pointer.expectedSha256,
        error: 'Bundle member SHA-256 does not match live paths registry',
      };
    }
    return {
      ...result,
      expectedSha256: pointer?.expectedSha256 ?? null,
    };
  }

  private readJsonMember(zip: ZipReader, member: string) {
    const entry = zip.getEntry(member);
    if (!entry) {
      return { verified: false, member, error: `Bundle member not found: ${member}` };
    }

    try {
      const data = entry.getData();
      const document = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')) as Record<
        string,
        unknown
      >;
      return {
        verified: true,
        member,
        sha256: this.sha256(data),
        bytes: data.length,
        schema: document.schema ?? null,
        version: document.version ?? null,
        role: document.role ?? null,
        commandCount:
          document.commands && typeof document.commands === 'object'
            ? Object.keys(document.commands as Record<string, unknown>).length
            : undefined,
        bootstrapOrder: Array.isArray(document.bootstrap_order)
          ? document.bootstrap_order
          : undefined,
      };
    } catch (error) {
      return {
        verified: false,
        member,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readOptionalJsonMember(zip: ZipReader, member: string) {
    const entry = zip.getEntry(member);
    if (!entry) return null;
    try {
      const data = entry.getData();
      const document = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''));
      return {
        member,
        sha256: this.sha256(data),
        bytes: data.length,
        schema: document?.schema ?? null,
        version: document?.version ?? null,
      };
    } catch {
      return null;
    }
  }

  private readOptionalTextMember(zip: ZipReader, member: string) {
    const entry = zip.getEntry(member);
    if (!entry) return null;
    const data = entry.getData();
    return {
      member,
      sha256: this.sha256(data),
      bytes: data.length,
    };
  }

  private async readJsonEvidence(
    area: string,
    repositoryPath: string,
    includeDocument: boolean,
  ): Promise<Evidence> {
    try {
      const storagePath = this.repositoryPathToStoragePath(repositoryPath);
      const target = this.roots.resolve(area, storagePath);
      const { stdout } = await this.rclone.run(['cat', target]);
      const normalized = stdout.replace(/^\uFEFF/, '');
      const document = JSON.parse(normalized) as Record<string, unknown>;
      const evidence: Evidence = {
        loaded: true,
        path: repositoryPath,
        sha256: this.sha256(normalized),
        bytes: Buffer.byteLength(normalized),
        summary: {
          schema: document.schema ?? null,
          version: document.version ?? null,
          role: document.role ?? null,
          state: document.state ?? null,
          overrideCount: Array.isArray(document.overrides)
            ? document.overrides.length
            : undefined,
        },
      };
      if (includeDocument) evidence.document = document;
      return evidence;
    } catch (error) {
      return {
        loaded: false,
        path: repositoryPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readTextEvidence(
    area: string,
    repositoryPath: string,
  ): Promise<Evidence> {
    try {
      const storagePath = this.repositoryPathToStoragePath(repositoryPath);
      const target = this.roots.resolve(area, storagePath);
      const { stdout } = await this.rclone.run(['cat', target]);
      const normalized = stdout.replace(/^\uFEFF/, '');
      return {
        loaded: true,
        path: repositoryPath,
        sha256: this.sha256(normalized),
        bytes: Buffer.byteLength(normalized),
        summary: {
          firstLine:
            normalized
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find(Boolean) ?? null,
        },
      };
    } catch (error) {
      return {
        loaded: false,
        path: repositoryPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async loadVisibleSources(
    storageArea: string,
    parsed: ParsedPathsRegistry,
    depth: 'basic' | 'normal' | 'deep',
  ) {
    const sources: Record<string, Evidence> = {};
    const definitions: Array<[string, string]> = [
      [
        'todo_current',
        this.routePath(parsed, 'todo_current', 'Documents/Notepad/todo.md'),
      ],
      [
        'todo_week',
        this.routePath(
          parsed,
          'todo_week',
          'Documents/Notepad/0_active/todo_week.md',
        ),
      ],
      [
        'todo_month',
        this.routePath(
          parsed,
          'todo_month',
          'Documents/Notepad/0_active/todo_month.md',
        ),
      ],
      [
        'toget',
        this.routePath(
          parsed,
          'toget',
          'Documents/Notepad/0_active/toget.md',
        ),
      ],
    ];

    if (depth !== 'basic') {
      definitions.push([
        'must_have',
        'Documents/Notepad/0_active/must_have.md',
      ]);
    }

    for (const [name, repositoryPath] of definitions) {
      sources[name] = await this.readTextDocument(storageArea, repositoryPath);
    }
    return sources;
  }

  private async readTextDocument(
    area: string,
    repositoryPath: string,
  ): Promise<Evidence> {
    try {
      const storagePath = this.repositoryPathToStoragePath(repositoryPath);
      const target = this.roots.resolve(area, storagePath);
      const { stdout } = await this.rclone.run(['cat', target]);
      const normalized = stdout.replace(/^\\uFEFF/, '');
      return {
        loaded: true,
        path: repositoryPath,
        sha256: this.sha256(normalized),
        bytes: Buffer.byteLength(normalized),
        document: normalized,
      };
    } catch (error) {
      return {
        loaded: false,
        path: repositoryPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async hydrateArea(
    storageArea: string,
    target: string,
    pointer: {
      rootId: string;
      manifestId: string;
      stateFolderId: string;
      stateId: string;
      configId: string;
    },
    warnings: string[],
  ) {
    const root =
      process.env.NYX_AREAS_ROOT_PATH?.trim() ||
      'ChatGPT/1_body/1_areas_v0';
    const base = path.posix.join(root, target);

    const result: Record<string, unknown> = { pointer };
    result.manifest = await this.readFirstJson(
      storageArea,
      [
        path.posix.join(base, 'area_paths.json'),
        path.posix.join(base, 'area_paths_v001.json'),
      ],
      `Area ${target} manifest`,
      warnings,
    );
    result.state = await this.readFirstJson(
      storageArea,
      [path.posix.join(base, '0_state/state.json')],
      `Area ${target} state`,
      warnings,
    );
    result.config = await this.readFirstJson(
      storageArea,
      [
        path.posix.join(base, '0_state/configs.json'),
        path.posix.join(base, '0_state/config.json'),
      ],
      `Area ${target} config`,
      warnings,
    );

    if (target.toLowerCase() === 'noteflow') {
      result.todo = await this.readFirstJson(
        storageArea,
        [path.posix.join(base, '0_state/todo.json')],
        'NoteFlow todo state',
        warnings,
      );
    }

    return result;
  }

  private async readFirstJson(
    storageArea: string,
    candidates: string[],
    label: string,
    warnings: string[],
  ) {
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const remote = this.roots.resolve(storageArea, candidate);
        const { stdout } = await this.rclone.run(['cat', remote]);
        return {
          path: candidate,
          document: JSON.parse(stdout.replace(/^\uFEFF/, '')),
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    warnings.push(`${label} hydration failed: ${errors.join(' | ')}`);
    return null;
  }

  private routePath(
    parsed: ParsedPathsRegistry,
    key: string,
    fallback: string,
  ) {
    return this.normalizeRepositoryPath(
      parsed.routes[key]?.repositoryPath || fallback,
    );
  }

  private normalizeRepositoryPath(repositoryPath: string) {
    return repositoryPath
      .replace(
        /^YaRoute\/0_repository\/3_subfooter(?=\/|$)/,
        'YaRoute/0_repository/3_template',
      )
      .trim();
  }

  private repositoryPathToStoragePath(repositoryPath: string) {
    const normalized = this.normalizeRepositoryPath(repositoryPath);
    const prefix = process.env.NYX_YARO_PREFIX?.trim() || 'YaRoute';
    if (normalized === 'YaRoute') return prefix;
    if (normalized.startsWith('YaRoute/')) {
      return `${prefix}/${normalized.slice('YaRoute/'.length)}`;
    }
    return normalized;
  }

  private memberFrom(bundlePath?: string) {
    if (!bundlePath) return undefined;
    return bundlePath.split('::')[1];
  }

  private sha256(value: string | Buffer) {
    return createHash('sha256').update(value).digest('hex');
  }
}
