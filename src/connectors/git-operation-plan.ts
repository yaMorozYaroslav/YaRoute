import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';

/**
 * COMPATIBILITY-ONLY. Owner explicitly chose API connectors instead of Git/Heroku
 * CLI access. These identifiers remain for historical records, but planning and
 * execution are permanently disabled. Use individually authorized GitHub/GitLab
 * REST or GraphQL API adapters instead.
 */
export const GIT_OPERATION_CAPABILITIES = {
  status: 'git:inspect', log: 'git:inspect', show: 'git:inspect',
  diff: 'git:diff', clone: 'git:clone', fetch: 'git:fetch',
  branch: 'git:branch', commit: 'git:commit', push: 'git:push', tag: 'git:tag',
} as const satisfies Record<string, ConnectorCapability>;
export type GitOperation = keyof typeof GIT_OPERATION_CAPABILITIES;

/** No implementation of this class may spawn Git or produce an executable plan. */
export class GitOperationPlanner {
  constructor(_registry: ConnectorRegistry) {}
  async plan(
    _ownerId: string,
    _connectionId: string,
    _operation: GitOperation,
    _repo: string,
    _branch?: string,
  ): Promise<never> {
    throw new Error('NYX_GIT_CLI_DISABLED_USE_PROVIDER_API');
  }
}
