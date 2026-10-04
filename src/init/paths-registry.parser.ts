import {
  AreaPointer,
  BundleMemberPointer,
  CorePointer,
  CoreRole,
  ParsedPathsRegistry,
  RoutePointer,
} from './init.types';

function clean(value: string) {
  return value.trim().replace(/^`|`$/g, '');
}

function sha256From(value: string): string | undefined {
  const match = value.match(/\b[0-9a-f]{64}\b/i);
  return match?.[0]?.toLowerCase();
}

function isDriveId(value: string) {
  return /^[A-Za-z0-9_-]{20,}$/.test(value);
}

export function parsePathsRegistry(markdown: string): ParsedPathsRegistry {
  const core: Record<CoreRole, CorePointer | undefined> = {
    Head: undefined,
    Body: undefined,
    Footer: undefined,
  };
  const routes: Record<string, RoutePointer> = {};
  const areas: Record<string, AreaPointer> = {};
  let canonicalCli: BundleMemberPointer | undefined;
  let compatibilityCommandTable: BundleMemberPointer | undefined;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => clean(cell));

    if (cells.length >= 5 && ['Head', 'Body', 'Footer'].includes(cells[0])) {
      const role = cells[0] as CoreRole;
      if (!core[role] && /\.zip$/i.test(cells[1])) {
        core[role] = {
          role,
          file: cells[1],
          repositoryPath: cells[2],
          driveId: cells[3],
          status: cells[4],
          expectedSha256: sha256From(cells[4]),
        };
      }
      continue;
    }

    if (
      cells.length >= 5 &&
      (cells[0] === 'Canonical executable CLI' || cells[0] === 'Yaro command table')
    ) {
      canonicalCli = {
        role: cells[0],
        file: cells[1],
        bundlePath: cells[2],
        driveId: cells[3],
        state: cells[4],
        expectedSha256: sha256From(cells[4]),
      };
      continue;
    }

    if (
      cells.length >= 5 &&
      (cells[0] === 'Compatibility command table' ||
        cells[0] === 'Legacy canonical command table')
    ) {
      compatibilityCommandTable = {
        role: cells[0],
        file: cells[1],
        bundlePath: cells[2],
        driveId: cells[3],
        state: cells[4],
        expectedSha256: sha256From(cells[4]),
      };
      continue;
    }

    if (
      cells.length >= 6 &&
      cells[0] &&
      cells[1] &&
      cells[2] &&
      cells[3] &&
      cells[4] &&
      cells[5] &&
      !['Area', '---'].includes(cells[0]) &&
      [cells[1], cells[2], cells[3], cells[4], cells[5]].every(isDriveId)
    ) {
      areas[cells[0]] = {
        area: cells[0],
        rootId: cells[1],
        manifestId: cells[2],
        stateFolderId: cells[3],
        stateId: cells[4],
        configId: cells[5],
      };
      continue;
    }

    if (
      cells.length >= 3 &&
      cells[0] &&
      cells[1] &&
      isDriveId(cells[2]) &&
      !['Key', 'Role', '---'].includes(cells[0])
    ) {
      routes[cells[0]] = {
        key: cells[0],
        repositoryPath: cells[1],
        driveId: cells[2],
        state: cells[3],
      };
    }
  }

  return {
    core,
    canonicalCli,
    compatibilityCommandTable,
    routes,
    areas,
  };
}
