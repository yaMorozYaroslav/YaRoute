/**
 * NON-OVERRIDABLE user boundary: NYX must not see payment information or be able
 * to cause direct billing/plan changes, including changes with recurring cost.
 *
 * This is a defense-in-depth code boundary, NOT a substitute for provider-side
 * credentials without billing privileges or an egress-restricted executor.
 */
export const FINANCIAL_POLICY_VERSION = 'nyx.financial-deny.v1' as const;

/** Legacy capability identifiers remain parseable for migration, but cannot be used. */
const prohibitedCapabilities = new Set([
  'heroku:apps:create',
  'heroku:config:write', // Unrestricted config changes can enable billable integrations.
  'heroku:formation:write',
  'heroku:addons:write',
  'heroku:plans:write',
  'heroku:billing:read',
  'heroku:billing:write',
  'heroku:payments:read',
  'heroku:payments:write',
]);

/** Reject BOTH reads and writes to financial/payment/billing surfaces. */
const forbiddenSegments = new Set([
  'billing', 'bill', 'billable', 'payment', 'payments', 'pay',
  'paymentmethods', 'creditcards', 'cards', 'invoices', 'invoice',
  'subscription', 'subscriptions', 'subscribe', 'purchase', 'purchases',
  'checkout', 'charges', 'charge', 'refund', 'refunds',
  'tariff', 'tariffs', 'pricing', 'priceplan', 'rateplan',
  'paidplans', 'paidplan', 'planupgrade', 'planchanges',
  'addon', 'addons', 'add-on', 'marketplace', 'formation',
  'dynosize', 'dynotype', 'scale', 'scaling',
  'provision', 'provisioning', 'costlimit', 'spendinglimit',
  'creditline', 'credits', 'costs', 'spend', 'spending',
]);

function segments(action: string): string[] {
  return action.toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1:$2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Use before accepting capability names, request operations and provider API paths. */
export function isFinanciallyProhibited(action: unknown): boolean {
  if (typeof action !== 'string' || !action.trim()) return true;
  const normalized = action.toLowerCase();
  if (prohibitedCapabilities.has(normalized)) return true;
  const parts = segments(normalized);
  if (parts.some(part => forbiddenSegments.has(part))) return true;

  // Explicit compound spellings often used for billing APIs.
  return /(?:billing|payment|subscription|purchase|checkout|tariff|invoic|creditcard|plan[-_]?chang|plan[-_]?upgrad|addon|dyno[-_]?type|dyno[-_]?size)/i.test(normalized);
}

export function assertNoFinancialAccess(action: unknown): void {
  if (isFinanciallyProhibited(action)) throw new Error('NYX_FINANCIAL_ACCESS_PERMANENTLY_FORBIDDEN');
}

/**
 * An execution adapter MUST accept typed allowlisted actions only. Unknown
 * actions fail closed; passing this predicate does NOT authorize execution.
 */
export function validateNonFinancialAction<T extends string>(
  action: unknown,
  allowlist: readonly T[],
): T {
  assertNoFinancialAccess(action);
  if (typeof action !== 'string' || !(allowlist as readonly string[]).includes(action)) {
    throw new Error('CONNECTOR_OPERATION_UNSUPPORTED');
  }
  return action as T;
}
