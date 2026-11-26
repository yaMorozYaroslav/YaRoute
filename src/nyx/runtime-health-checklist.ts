/**
 * Verified observations for the private NYX runtime checklist.
 *
 * No mutations and no source-content returns. A reported version or a green
 * CI build is NOT proof that the deployment matches canonical Head/Body/Footer.
 */
export type ChecklistStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNVERIFIED';

export interface ChecklistItem {
  id: string;
  status: ChecklistStatus;
  evidence: string;
  details?: Record<string, unknown>;
}
export type ProfileDiagnostic = {
  configured?: boolean;
  ready?: boolean;
  authorityMatches?: boolean;
  error?: string;
  keys?: Array<{ key: string; mode: string; status: string }>;
};

export function buildNyxRuntimeChecklist(input: {
  runtimeCommit?: string;
  canonical?: { head: string; body: string; footer: string };
  cli?: { version: string; sha256: string; commands: Record<string, unknown> };
  profile?: ProfileDiagnostic;
  effectiveCommands?: string[];
  sourceError?: string;
  privateBootstrapUnavailable?: boolean;
}) {
  const checks: ChecklistItem[] = [];
  const add = (id: string, status: ChecklistStatus, evidence: string, details?: Record<string, unknown>) =>
    checks.push({ id, status, evidence, ...(details ? { details } : {}) });

  const commit = /^[a-f0-9]{40}$/.test(input.runtimeCommit || '') ? input.runtimeCommit : null;
  add('deployment.commit', commit ? 'PASS' : 'UNVERIFIED',
    commit ? 'Running process reports a Git commit; compare with Tester using CI attestation.' : 'No verified runtime Git commit in process environment.',
    { runtimeCommit: commit, matchesTester: null });

  if (input.sourceError || !input.canonical || !input.cli) {
    add('canonical.registry', input.privateBootstrapUnavailable ? 'UNVERIFIED' : 'FAIL',
      input.privateBootstrapUnavailable
        ? 'Private operator bootstrap is intentionally inaccessible to public tenants.'
        : 'Live canonical CLI/bootstrap could not be resolved.');
    add('canonical.bundles', 'UNVERIFIED', 'Core bundle bytes, manifest and hashes not compared.');
    add('cli.contracts', 'UNVERIFIED', 'Canonical command registry unavailable.');
    add('runtime.profile', 'UNVERIFIED', 'Execution profile not inspected.');
    add('template.pins', 'UNVERIFIED', 'Live Template/temp key pins not inspected.');
  } else {
    add('canonical.registry', 'PASS', 'Canonical CLI loaded from current bootstrap and validated by the registry.',
      { version: input.cli.version, sha256: input.cli.sha256, commands: Object.keys(input.cli.commands).length });
    // Locator labels alone do not prove these ZIPs are the newest valid canonical bundles.
    add('canonical.bundles', 'UNVERIFIED',
      'Bootstrap labels observed; independent Head/Body/Footer ZIP hashes, manifest and current Footer continuity were not compared.',
      { labels: input.canonical, verifiedCoreHashes: false, latestFooterValidated: false });

    const commands = Object.keys(input.cli.commands);
    const effective = input.effectiveCommands === undefined ? null :
      commands.filter(x => input.effectiveCommands?.includes(x));
    add('cli.contracts', effective === null ? 'UNVERIFIED' : effective.length === commands.length ? 'PASS' : 'WARN',
      effective === null ? 'Runtime binding could not be validated.' :
      'Counts only typed backend execution contracts, not actual command-execution tests.',
      { total: commands.length, bound: effective?.length ?? null,
        canonicalOnly: effective === null ? [] : commands.filter(x => !effective.includes(x)) });

    const p = input.profile;
    if (!p || p.error) {
      add('runtime.profile', 'FAIL', 'Execution profile inspection failed or is unavailable.');
      add('template.pins', 'UNVERIFIED', 'Profile pins could not be evaluated.');
    } else {
      add('runtime.profile', p.ready && p.configured && p.authorityMatches ? 'PASS' :
        p.configured ? 'FAIL' : 'UNVERIFIED',
        p.ready && p.configured && p.authorityMatches
          ? 'Configured execution profile CLI fingerprint matches current Head CLI.'
          : 'No verified matching execution profile.',
        { configured: p.configured === true, cliFingerprintMatches: p.authorityMatches === true });
      const pins = p.keys ?? [];
      const enforcedDrift = pins.some(x => x.mode !== 'observe' && x.status !== 'verified');
      const observedDrift = pins.some(x => x.mode === 'observe' && x.status !== 'verified');
      const pinState: ChecklistStatus = !p.configured || !pins.length ? 'UNVERIFIED' :
        enforcedDrift ? 'FAIL' : observedDrift ? 'WARN' : 'PASS';
      add('template.pins', pinState,
        'Verified pinned key fingerprints only; observed draft changes remain warnings and cannot silently become authority.',
        { keys: pins.map(x => ({ key: x.key, mode: x.mode, status: x.status })),
          pinnedKeys: pins.length, enforcedDrift, observedDrift });
    }
  }

  add('template.queue', 'UNVERIFIED',
    'No authoritative Template/temp_keys/temp_files manifest, pending seed inventory or Footer queue reconciliation attestation.');
  add('cli.smoke', 'UNVERIFIED',
    'No side-effecting Nyx CLI commands were executed. Every canonical command needs an isolated, authorized fixture and result receipts.');
  add('ci.functions', 'UNVERIFIED',
    'A runtime response cannot prove which GitHub CI tests ran. Require exact-SHA workflow run, test counts and failure records.');
  add('security.tenants', 'UNVERIFIED',
    'Two-account, exact-root, credential, revocation and restart checks need isolated integration evidence.');
  const summary = { pass: 0, warn: 0, fail: 0, unverified: 0 };
  for (const check of checks) {
    if (check.status === 'PASS') summary.pass++;
    else if (check.status === 'WARN') summary.warn++;
    else if (check.status === 'FAIL') summary.fail++;
    else summary.unverified++;
  }
  return {
    schema: 'nyx.runtime-checklist.v1',
    overall: summary.fail ? 'BLOCKED' : summary.warn || summary.unverified ? 'NEEDS_REVIEW' : 'READY',
    summary, checks,
    readOnly: true, productionApproved: false,
    note: 'Not a release gate unless separately signed off against live canonical and CI evidence.',
  };
}
