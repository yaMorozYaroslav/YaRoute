import type { ConnectorConnection } from './connector-registry';

/** Historical Git CLI capability names. CLI work is explicitly prohibited. */
export const GIT_OPERATIONS = {
  status:'git:inspect',log:'git:inspect',show:'git:inspect',
  clone:'git:clone',fetch:'git:fetch',diff:'git:diff',
  'branch.create':'git:branch',commit:'git:commit',
  push:'git:push','tag.create':'git:tag',
} as const;
export type GitOperation = keyof typeof GIT_OPERATIONS;

/** Compatibility-only shim; never produces any executable or CLI plan. */
export function authorizeGitPlan(
  _connection:ConnectorConnection,_operation:GitOperation,
  _repository:string,_branch?:string,_approved=false,
):never {
  throw new Error('NYX_GIT_CLI_DISABLED_USE_PROVIDER_API');
}
