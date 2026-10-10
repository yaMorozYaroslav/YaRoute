import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';
import { assessPotentialFinancialLoss } from './financial-risk-preflight';

/** Typed operation planning only: no arbitrary CLI strings and no process spawning. */
export const GIT_OPERATION_CAPABILITIES = {
 status:'git:inspect', log:'git:inspect', show:'git:inspect',
 diff:'git:diff', clone:'git:clone', fetch:'git:fetch',
 branch:'git:branch', commit:'git:commit', push:'git:push', tag:'git:tag'
} as const satisfies Record<string, ConnectorCapability>;

export type GitOperation = keyof typeof GIT_OPERATION_CAPABILITIES;
export class GitOperationPlanner {
 constructor(private readonly registry: ConnectorRegistry) {}
 async plan(ownerId:string, connectionId:string, operation:GitOperation, repo:string, branch?:string) {
  if (!Object.prototype.hasOwnProperty.call(GIT_OPERATION_CAPABILITIES,operation)) throw new Error('GIT_OPERATION_UNSUPPORTED');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes('..')) throw new Error('GIT_REPOSITORY_INVALID');
  if (branch && (!/^[\w.\/-]{1,120}$/.test(branch) || branch.includes('..'))) throw new Error('GIT_BRANCH_INVALID');
  const capability=GIT_OPERATION_CAPABILITIES[operation];
  const connection = await this.registry.requireResource(ownerId,connectionId,capability,{kind:'repository',id:repo,branch});
  const financialRisk = assessPotentialFinancialLoss({provider: connection.provider, operation: 'git:' + operation});
  return {operation,repo,branch,connectionId,capability,requiresApproval:financialRisk.mustNotify || ['branch','commit','push','tag'].includes(operation),
    financialRisk,
    executor:'isolated-git-worker',executable:false};
 }
}
