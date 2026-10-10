/** Typed Git capability map. Execution is NOT enabled by this definition. */
export const GIT_OPERATIONS = {
  status: 'git:inspect', log: 'git:inspect', show: 'git:inspect',
  clone: 'git:clone', fetch: 'git:fetch', diff: 'git:diff',
  'branch.create': 'git:branch', commit: 'git:commit',
  push: 'git:push', 'tag.create': 'git:tag',
} as const;
export type GitOperation = keyof typeof GIT_OPERATIONS;

import type { ConnectorConnection } from './connector-registry';
/** Policy-only plan; it does not start Git or grant remote authorization. */
export function authorizeGitPlan(connection: ConnectorConnection, operation: GitOperation,
  repository: string, branch?: string, approved = false) {
  if (connection.provider !== 'github' && connection.provider !== 'gitlab') throw new Error('GIT_PROVIDER_INVALID');
  if (!Object.prototype.hasOwnProperty.call(GIT_OPERATIONS, operation)) throw new Error('GIT_OPERATION_UNSUPPORTED');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes('..')) throw new Error('GIT_REPOSITORY_INVALID');
  if (branch !== undefined && (!/^[A-Za-z0-9_./-]{1,120}$/.test(branch) || branch.includes('..') || branch.startsWith('-'))) throw new Error('GIT_BRANCH_INVALID');
  const capability = GIT_OPERATIONS[operation];
  if (connection.status !== 'active') throw new Error('CONNECTOR_INACTIVE');
  if (!connection.capabilities.includes(capability)) throw new Error('GIT_PERMISSION_DISABLED');
  if (!connection.providerCapabilities.includes(capability)) throw new Error('GIT_PROVIDER_PERMISSION_REQUIRED');
  if (!(connection.resources ?? []).some(rule => rule.kind === 'repository' &&
    rule.id.toLowerCase() === repository.toLowerCase() &&
    rule.capabilities.includes(capability) && !rule.pathPrefix &&
    (!rule.branches?.length || (branch !== undefined && rule.branches.includes(branch))))) {
    throw new Error('GIT_RESOURCE_FORBIDDEN');
  }
  if (operation === 'push' && !approved) throw new Error('GIT_APPROVAL_REQUIRED');
  return {operation,repository,branch,capability,requiresApproval:operation === 'push',
    executor:'isolated-git-worker' as const, executable:false as const};
}
