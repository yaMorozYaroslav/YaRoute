import { isFinanciallyProhibited } from './financial-safety';

/**
 * Conservative pre-execution impact prediction.
 *
 * This is a preview, NOT execution authorization or a financial prediction.
 * Unrecognized or ambiguously chargeable actions fail closed. Never use client-
 * supplied cost-control flags to turn a HOLD into an automatic execution.
 */
export type LossSeverity = 'low' | 'elevated' | 'high' | 'forbidden' | 'unknown';
export type LossDecision = 'allow-low-risk-read' | 'warn-and-hold' | 'deny';

export type LossRiskCategory =
  | 'direct-financial-control' | 'metered-compute' | 'api-usage'
  | 'storage-growth' | 'network-egress' | 'automation-trigger'
  | 'recurring-consumption' | 'data-loss' | 'service-disruption'
  | 'credential-exposure' | 'supply-chain' | 'unknown-impact';

export interface PotentialLossRequest {
  provider: 'github' | 'gitlab' | 'google-drive' | 'mega' | 'heroku' | 'neon' | 'other';
  operation: string;
  /** Optional verified operation metadata. Do not infer missing evidence as zero risk. */
  paths?: string[];
  /** Estimated workload quantity; supplied by trusted server-side instrumentation. */
  estimatedCalls?: number;
  estimatedBytes?: number;
  recurring?: boolean;
  crossProvider?: boolean;
}
export interface PotentialLossAssessment {
  policy: 'nyx.potential-loss-preflight.v1';
  severity: LossSeverity;
  decision: LossDecision;
  mustNotify: boolean;
  mayRunAutonomously: boolean;
  categories: LossRiskCategory[];
  warnings: string[];
  prerequisites: string[];
  costEstimateAvailable: false;
  /** There is no provider billing access: cost may be unknown. */
  actualCostUnknown: true;
}

const knownOperations = new Set([
  'git:status', 'git:log', 'git:show', 'git:diff', 'git:clone', 'git:fetch',
  'git:branch', 'git:commit', 'git:push', 'git:tag',
  'git:checkout', 'git:merge', 'git:rebase', 'git:cherry-pick', 'git:revert',
  'git:stash', 'git:reset', 'git:clean', 'git:worktree',
  'ci:read', 'ci:dispatch', 'repository:metadata',
  'storage:list', 'storage:stat', 'storage:read', 'storage:capacity',
  'storage:index', 'storage:write', 'storage:copy', 'storage:move',
  'storage:delete', 'resources:read', 'contents:write',
  'heroku:app.info', 'heroku:app.releases', 'heroku:app.logs',
  'heroku:config.names', 'heroku:app.deploy', 'heroku:app.restart',
  'nyx:global-index',
]);

const forbiddenOperations = new Set([
  'heroku:app.create', 'heroku:app.scale', 'heroku:config.set',
  'heroku:addon.create', 'heroku:formation.change', 'heroku:dyno.resize',
  'neon:project.create', 'neon:compute.resize',
  'cloud:resource.create', 'cloud:plan.change',
]);

const readOnlyActions = new Set([
  'git:status', 'git:log', 'git:show', 'git:diff',
  'repository:metadata', 'ci:read', 'resources:read',
  'storage:list', 'storage:stat', 'storage:read', 'storage:capacity',
  'heroku:app.info', 'heroku:app.releases', 'heroku:app.logs',
  'heroku:config.names',
]);

const complexActions = new Set([
  'heroku:app.deploy', 'heroku:app.restart',
  'git:push', 'git:merge', 'git:rebase', 'git:cherry-pick', 'git:reset',
  'git:clean', 'git:commit', 'git:tag', 'git:branch',
  'ci:dispatch', 'storage:delete', 'storage:move',
]);

/**
 * High-impact paths requiring out-of-band review even when the Git action
 * otherwise appears benign. This catches direct and indirect recurring charges,
 * compromised deploys and security-policy changes without reading billing data.
 */
const protectedPath = /(?:^|\/)(?:\.github\/workflows\/|\.github\/actions\/|terraform\/|infra\/|infrastructure\/|billing\/|payment\/|secrets?\/|Dockerfile$|Procfile$|heroku\.yml$|package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.env(?:\.|$)|financial-safety\.ts$|financial-risk-preflight\.ts$)/i;

export function assessPotentialFinancialLoss(request: PotentialLossRequest): PotentialLossAssessment {
  const categories = new Set<LossRiskCategory>();
  const warnings: string[] = [];
  const prerequisites: string[] = [];
  let severity: LossSeverity = 'low';
  let decision: LossDecision = 'allow-low-risk-read';
  const add = (category: LossRiskCategory, warning: string, required?: string) => {
    categories.add(category);
    warnings.push(warning);
    if (required) prerequisites.push(required);
  };
  const hold = (high = false) => {
    if (high || severity !== 'high') severity = high ? 'high' : 'elevated';
    decision = 'warn-and-hold';
  };

  const operation = typeof request.operation === 'string' ? request.operation.trim().toLowerCase() : '';
  const provider = request.provider;
  if (!operation || forbiddenOperations.has(operation) || isFinanciallyProhibited(operation)) {
    return {
      policy: 'nyx.potential-loss-preflight.v1', severity: 'forbidden',
      decision: 'deny', mustNotify: true, mayRunAutonomously: false,
      categories: ['direct-financial-control'],
      warnings: ['NYX must not access payments, tariffs, billing or paid-resource controls.'],
      prerequisites: ['Perform financial administration personally outside NYX.'],
      costEstimateAvailable: false, actualCostUnknown: true,
    };
  }
  if (!knownOperations.has(operation) || !['github','gitlab','google-drive','mega','heroku','neon'].includes(provider)) {
    return {
      policy: 'nyx.potential-loss-preflight.v1', severity: 'unknown',
      decision: 'deny', mustNotify: true, mayRunAutonomously: false,
      categories: ['unknown-impact'],
      warnings: ['Financial exposure cannot be ruled out for this unrecognized operation.'],
      prerequisites: ['Review and add an explicit non-financial operation policy before execution.'],
      costEstimateAvailable: false, actualCostUnknown: true,
    };
  }

  if (!readOnlyActions.has(operation)) {
    hold(complexActions.has(operation));
  }

  if (operation === 'git:push' || operation === 'ci:dispatch') {
    hold(true);
    add('automation-trigger',
      'This action can trigger paid CI, builds, deployments or downstream automations.',
      'Manually verify provider spending protections; inspect triggered workflows and exact commit before enabling.');
    add('recurring-consumption',
      'A changed workflow may repeatedly consume resources after the original action finishes.');
  } else if (operation === 'git:commit' || operation === 'git:merge' || operation === 'git:rebase') {
    hold(true);
    add('supply-chain',
      'Changed code or dependencies may later trigger paid services, outages or security incidents.',
      'Inspect the full diff and workflow implications before publishing.');
  } else if (operation === 'git:clone' || operation === 'git:fetch') {
    hold();
    add('network-egress', 'Repository transfer and cache storage can consume metered resources.');
  }

  if (operation === 'heroku:app.deploy') {
    hold(true);
    add('metered-compute',
      'Deployment/builds can consume resources on existing paid services or activate recurring work.',
      'Verify cost controls manually in Heroku; approve an exact release and check a rollback plan.');
    add('service-disruption', 'Deployments can cause downtime, errors or data migrations.');
  } else if (operation === 'heroku:app.restart') {
    hold(true);
    add('service-disruption', 'Restarting an application can cause downtime or repeated startup work.',
      'Review current production health and approve the exact app and operation.');
    add('metered-compute', 'Repeated restarts can increase resource usage.');
  }

  if (operation.startsWith('storage:') || operation === 'nyx:global-index') {
    if (['storage:write','storage:copy','storage:move','storage:index','nyx:global-index'].includes(operation)) {
      hold(operation === 'storage:move');
      add('storage-growth', 'File transfers, indexes and retained copies may create ongoing storage usage.',
        'Check target, volume and retention; use bounded batches and verify outputs.');
      add('api-usage', 'Bulk listing and file operations may consume metered provider/API quotas.');
    }
    if (operation === 'storage:delete' || operation === 'storage:move') {
      hold(true);
      add('data-loss', 'Deletion or movement errors can cause permanent loss or recovery expense.',
        'Require a verified backup, destination readback and explicit manual review.');
    }
    if (request.crossProvider) {
      hold(true);
      add('network-egress', 'Cross-provider transfers can incur traffic charges.',
        'Manually check provider transfer pricing and configure external spending safeguards.');
    }
  }

  if (operation === 'contents:write') {
    hold();
    add('data-loss', 'Overwriting or changing content can create recovery or downtime costs.',
      'Verify destination, version history and rollback before writing.');
  }

  const paths = request.paths;
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.length > 500 || paths.some(path => typeof path !== 'string' || path.length > 2048)) {
      return {
        policy: 'nyx.potential-loss-preflight.v1', severity: 'unknown',
        decision: 'deny', mustNotify: true, mayRunAutonomously: false,
        categories: ['unknown-impact'], warnings: ['Unverifiable changed-file list: risk assessment incomplete.'],
        prerequisites: ['Obtain a bounded server-verified change manifest.'],
        costEstimateAvailable: false, actualCostUnknown: true,
      };
    }
    if (paths.some(path => protectedPath.test(path))) {
      hold(true);
      add('automation-trigger',
        'The change affects deployment, billing-sensitive, dependency, infrastructure or safety-policy files.',
        'Review the complete diff outside NYX before allowing a deployment or push.');
      add('credential-exposure', 'Infrastructure and workflow changes can expose secrets or elevated credentials.');
    }
  }

  if (request.recurring) {
    hold(true);
    add('recurring-consumption', 'Recurring tasks can accumulate charges or damage over time.',
      'Require a finite execution count and an independent off switch.');
  }
  if (request.estimatedCalls !== undefined) {
    if (!Number.isSafeInteger(request.estimatedCalls) || request.estimatedCalls < 0) {
      return {
        policy: 'nyx.potential-loss-preflight.v1', severity: 'unknown',
        decision: 'deny', mustNotify: true, mayRunAutonomously: false,
        categories: ['unknown-impact'], warnings: ['Invalid workload count.'],
        prerequisites: ['Provide verified non-negative workload bounds.'],
        costEstimateAvailable: false, actualCostUnknown: true,
      };
    }
    if (request.estimatedCalls >= 100) {
      hold(true);
      add('api-usage', 'Large call volume can accumulate API, CI or compute usage charges.',
        'Apply an internal execution cap and independently check provider-side cost controls.');
    }
  }
  if (request.estimatedBytes !== undefined) {
    if (!Number.isSafeInteger(request.estimatedBytes) || request.estimatedBytes < 0) {
      return {
        policy: 'nyx.potential-loss-preflight.v1', severity: 'unknown',
        decision: 'deny', mustNotify: true, mayRunAutonomously: false,
        categories: ['unknown-impact'], warnings: ['Invalid data-volume estimate.'],
        prerequisites: ['Provide a server-verified transfer bound.'],
        costEstimateAvailable: false, actualCostUnknown: true,
      };
    }
    if (request.estimatedBytes >= 1024 ** 3) {
      hold(true);
      add('network-egress', 'Large data volume may incur bandwidth and storage costs.',
        'Manually verify limits and inspect the transfer volume.');
    }
  }

  // Default risk notices do not assert that zero dollars will be spent.
  if (decision === 'allow-low-risk-read') {
    add('api-usage', 'Even a bounded read may contribute to a provider quota or metered usage.');
  }
  return {
    policy: 'nyx.potential-loss-preflight.v1',
    severity, decision, mustNotify: decision !== 'allow-low-risk-read',
    mayRunAutonomously: decision === 'allow-low-risk-read',
    categories: [...categories], warnings, prerequisites,
    costEstimateAvailable: false, actualCostUnknown: true,
  };
}

/** Guard for autonomous worker dispatch: the preview cannot authorize writes. */
export function assertEligibleForAutonomousExecution(assessment: PotentialLossAssessment): void {
  if (assessment.decision !== 'allow-low-risk-read' || !assessment.mayRunAutonomously) {
    throw new Error('NYX_FINANCIAL_RISK_REQUIRES_MANUAL_REVIEW');
  }
}
