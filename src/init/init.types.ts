export type InitScope = 'local' | 'global';
export type InitDepth = 'basic' | 'normal' | 'deep';

export type InitInput = {
  target?: string;
  targets?: string[];
  conversationId?: string;
  scope?: InitScope;
  sessionId?: string;
  depth?: InitDepth;
};

export type CoreRole = 'Head' | 'Body' | 'Footer';

export type CorePointer = {
  role: CoreRole;
  file: string;
  repositoryPath: string;
  driveId: string;
  status: string;
  expectedSha256?: string;
};

export type BundleMemberPointer = {
  role: string;
  file: string;
  bundlePath: string;
  driveId: string;
  state: string;
  expectedSha256?: string;
};

export type RoutePointer = {
  key: string;
  repositoryPath: string;
  driveId: string;
  state?: string;
};

export type AreaPointer = {
  area: string;
  rootId: string;
  manifestId: string;
  stateFolderId: string;
  stateId: string;
  configId: string;
};

export type ParsedPathsRegistry = {
  core: Record<CoreRole, CorePointer | undefined>;
  canonicalCli?: BundleMemberPointer;
  compatibilityCommandTable?: BundleMemberPointer;
  routes: Record<string, RoutePointer>;
  areas: Record<string, AreaPointer>;
};

export type InitSession = {
  id: string;
  target?: string;
  scope: InitScope;
  createdAt: string;
  updatedAt: string;
  receipt: unknown;
};

export type InitReadiness = 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY';
