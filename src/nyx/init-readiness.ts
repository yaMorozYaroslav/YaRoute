/**
 * Fail-closed INI readiness. The caller must supply server-verified receipts:
 * a parser result, a successful HTTP health check, or an archive hash alone
 * NEVER constitutes a completed initialization.
 *
 * This is an internal gate assessor, not a new authority source. Head supplies
 * command semantics; owning Areas supply live mutable state. Do not expose an
 * endpoint that allows untrusted callers to set these flags.
 */
export const REQUIRED_INI_GATES = Object.freeze([
  'canonical_pointer_verified',
  'live_cli_and_routes_verified',
  'all_target_owners_resolved',
  'all_required_source_reads_verified',
  'all_required_visible_renders_verified',
  'conversation_fif_persisted_and_read_back',
  'live_runtime_feature_verified',
] as const);

export type IniGate = typeof REQUIRED_INI_GATES[number];
export type IniGateReceipts = Readonly<Partial<Record<IniGate, boolean>>>;

export function inspectIniReadiness(receipts: IniGateReceipts = {}) {
  const missingGates = REQUIRED_INI_GATES.filter(gate => receipts[gate] !== true);
  return {
    schema: 'nyx.ini.readiness-gates.v1' as const,
    status: missingGates.length === 0 ? 'READY' as const : 'PARTIAL_DIAGNOSTIC' as const,
    complete: missingGates.length === 0,
    missingGates,
    verifiedGates: REQUIRED_INI_GATES.filter(gate => receipts[gate] === true),
    // This function does not create a FIF or verify any receipt by itself.
    checksOnly: true as const,
  };
}
