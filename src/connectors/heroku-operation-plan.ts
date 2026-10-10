import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';
import { assertNoFinancialAccess, validateNonFinancialAction } from './financial-safety';
import { assessPotentialFinancialLoss } from './financial-risk-preflight';

/**
 * Heroku operations must NEVER include billing, plan changes, dyno scaling,
 * paid resource creation or unrestricted configuration writes.
 * A ChatGPT permission toggle cannot override this policy.
 */
export const HEROKU_OPERATIONS = {
  'app.info': 'heroku:apps:read',
  'app.releases': 'heroku:releases:read',
  'app.logs': 'heroku:logs:read',
  'config.names': 'heroku:config:names',
  'app.deploy': 'heroku:deploy',
  'app.restart': 'heroku:apps:restart',
} as const satisfies Record<string, ConnectorCapability>;

export type HerokuOperation = keyof typeof HEROKU_OPERATIONS;

/** Operations removed from the initial roadmap because of financial exposure. */
export const FORBIDDEN_HEROKU_OPERATIONS = [
  'app.create',
  'config.set', // Unrestricted config writes may enable billable services.
  'app.scale',
  'app.plan',
  'app.upgrade',
  'addon.create',
  'addon.change',
  'payment.read',
  'payment.update',
  'billing.read',
  'billing.update',
] as const;

export class HerokuOperationPlanner {
  constructor(private readonly registry: ConnectorRegistry) {}

  async plan(ownerId: string, connectionId: string, operation: string, resourceId: string) {
    if ((FORBIDDEN_HEROKU_OPERATIONS as readonly string[]).includes(operation)) {
      throw new Error('NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN');
    }
    // Also deny future financial operation names not on the known blacklist.
    assertNoFinancialAccess(operation);
    const allowed = validateNonFinancialAction(operation, Object.keys(HEROKU_OPERATIONS) as HerokuOperation[]);
    const capability = HEROKU_OPERATIONS[allowed];
    assertNoFinancialAccess(capability);
    await this.registry.requireResource(ownerId, connectionId, capability, {
      kind: 'heroku-app', id: resourceId,
    });
    const financialRisk = assessPotentialFinancialLoss({provider: 'heroku', operation: 'heroku:' + allowed});
    if (financialRisk.decision === 'deny') throw new Error('NYX_FINANCIAL_RISK_BLOCKED');
    // This ONLY returns a plan: there is no Heroku administration executor.
    // Deployment/restart must be explicitly approved and separately screened.
    return {
      operation: allowed,
      connectionId,
      resourceId,
      capability,
      approvalRequired: financialRisk.mustNotify || ['app.deploy', 'app.restart'].includes(allowed),
      financialRisk,
      executor: 'heroku-platform-api' as const,
      executable: false as const,
    };
  }
}
