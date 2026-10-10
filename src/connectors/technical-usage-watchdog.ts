/**
 * Technical-only NYX abnormal-usage detector.
 *
 * Never queries, reads, estimates or changes a provider's financial data.
 * Pure risk signals; a production worker must supply measured counters from
 * trusted server-side instrumentation and deliver alerts independently.
 */
export type UsageSignal =
  | 'ci-runs' | 'deployments' | 'failed-deployments' | 'job-retries'
  | 'api-requests' | 'bytes-transferred' | 'storage-growth-bytes'
  | 'deleted-files' | 'active-automations';

export type UsageVerdict = 'normal' | 'warn' | 'freeze-and-warn';
export interface TechnicalUsage {
  signal: UsageSignal;
  count: number;
  /** Number of minutes covered by the measured counter. */
  windowMinutes: number;
}
export interface UsageWarning {
  policy: 'nyx.technical-usage-watchdog.v1';
  signal: UsageSignal;
  verdict: UsageVerdict;
  mustNotify: boolean;
  freezeAutomations: boolean;
  message: string;
  billingDataUsed: false;
}

/** Conservative starting bounds, subject to non-financial technical tuning. */
const thresholds: Record<UsageSignal, {windowMinutes: number; warning: number; stop: number}> = {
  'ci-runs': {windowMinutes: 60, warning: 5, stop: 12},
  deployments: {windowMinutes: 60, warning: 2, stop: 4},
  'failed-deployments': {windowMinutes: 60, warning: 1, stop: 3},
  'job-retries': {windowMinutes: 60, warning: 5, stop: 10},
  'api-requests': {windowMinutes: 60, warning: 200, stop: 500},
  'bytes-transferred': {windowMinutes: 60, warning: 256 * 1024 ** 2, stop: 1024 ** 3},
  'storage-growth-bytes': {windowMinutes: 1440, warning: 512 * 1024 ** 2, stop: 2 * 1024 ** 3},
  'deleted-files': {windowMinutes: 60, warning: 1, stop: 5},
  'active-automations': {windowMinutes: 60, warning: 5, stop: 10},
};

export function assessTechnicalUsage(input: TechnicalUsage): UsageWarning {
  const rule = thresholds[input.signal];
  if (!rule || !Number.isSafeInteger(input.count) || input.count < 0 ||
      !Number.isSafeInteger(input.windowMinutes) ||
      input.windowMinutes !== rule.windowMinutes) {
    return {
      policy:'nyx.technical-usage-watchdog.v1',
      signal: input.signal,
      verdict: 'freeze-and-warn',
      mustNotify: true,
      freezeAutomations: true,
      message: 'Technical usage is unverified or lacks an approved observation window. Suspend automation and investigate.',
      billingDataUsed: false,
    };
  }
  const verdict: UsageVerdict = input.count >= rule.stop ? 'freeze-and-warn' :
    input.count >= rule.warning ? 'warn' : 'normal';
  const message = verdict === 'freeze-and-warn'
    ? 'Unusually high technical usage: stop further automated jobs, warn the owner, and inspect possible cost exposure.'
    : verdict === 'warn'
      ? 'Technical usage is approaching the conservative limit; warn the owner and avoid increasing workload.'
      : 'Usage is within the provisional technical observation limit (not a guarantee of zero cost).';
  return {
    policy:'nyx.technical-usage-watchdog.v1',
    signal: input.signal,
    verdict,
    mustNotify: verdict !== 'normal',
    freezeAutomations: verdict === 'freeze-and-warn',
    message,
    billingDataUsed: false,
  };
}
