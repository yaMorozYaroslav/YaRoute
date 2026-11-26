
import { buildNyxRuntimeChecklist, type ChecklistStatus } from '../nyx/runtime-health-checklist';

/** GitHub REST is used only for a public, fixed repository; no OAuth or private source data. */
const github = 'https://api.github.com/repos/yaMorozYaroslav/YaRoute';
const SHA = /^[a-f0-9]{40}$/;
const short = (value: string) => value.slice(0, 40);
export type PublicEvidence = {
  status: ChecklistStatus;
  evidence: string;
  details?: Record<string, unknown>;
};
export type PublicGitHubData = {
  testerSha?: string;
  checks?: Array<{ name: string; status: string; conclusion: string | null; sha?: string }>;
  error?: string;
};

const sanitize = (value: unknown) =>
  typeof value === 'string' && SHA.test(value) ? value : null;

/** Pure and testable. A passing build is not proof of each command or function test. */
export function assessGitHubEvidence(observed: string, data: PublicGitHubData) {
  const sha = sanitize(observed);
  const target = sanitize(data.testerSha);
  const commit: PublicEvidence = !sha || !target ? {
    status: 'UNVERIFIED',
    evidence: 'Runtime/Tester commit comparison unavailable; no equality claim.',
  } : sha === target ? {
    status: 'PASS',
    evidence: 'Deployed commit exactly matches the current Tester branch tip.',
    details: { runtimeSha: sha, testerSha: target },
  } : {
    status: 'WARN',
    evidence: 'Runtime commit differs from current Tester tip; deployment may lag.',
    details: { runtimeSha: sha, testerSha: target },
  };

  const matching = sha && Array.isArray(data.checks) ? data.checks.filter(x => x.sha === sha) : [];
  const normalized = matching.map(x => ({
    name: String(x.name || '').slice(0, 90),
    status: String(x.status || '').slice(0, 24),
    conclusion: x.conclusion === null ? null : String(x.conclusion || '').slice(0, 24),
  }));
  const build = normalized.filter(x => x.name === 'build');
  const audit = normalized.filter(x => x.name === 'audit' || x.name === 'GitGuardian Security Checks');
  const failed = [...build, ...audit].some(x => ['failure', 'timed_out', 'cancelled'].includes(x.conclusion || ''));
  const allBuildsPass = build.length > 0 && build.every(x => x.status === 'completed' && x.conclusion === 'success');
  const allAuditsPass = audit.length > 0 && audit.every(x => x.status === 'completed' && x.conclusion === 'success');
  const ci: PublicEvidence = failed ? {
    status: 'FAIL', evidence: 'At least one exact-SHA build/security check failed.',
    details: { checks: normalized },
  } : allBuildsPass && allAuditsPass ? {
    status: 'PASS', evidence: 'Exact-SHA GitHub build and security checks passed (not individual test-case attestation).',
    details: { checks: normalized },
  } : {
    status: 'UNVERIFIED',
    evidence: data.error ? 'GitHub public check-run evidence unavailable.' :
      'No completed exact-SHA build and security check set. Missing or pending is not success.',
    details: { checks: normalized },
  };
  return { commit, ci };
}

/** Bounded fixed-origin GitHub reads, with no secrets and no user-supplied URLs. */
export async function fetchPublicGitHubEvidence(observed: string,
  request: (url: string) => Promise<unknown> = async url => {
    const response = await fetch(url, {
      method: 'GET', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NestNyx-Public-Health' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('PUBLIC_GITHUB_NOT_AVAILABLE');
    const declared = Number(response.headers.get('content-length') || '0');
    if (declared > 400_000) throw new Error('PUBLIC_GITHUB_RESPONSE_OVERSIZE');
    const raw = await response.text();
    if (raw.length > 400_000) throw new Error('PUBLIC_GITHUB_RESPONSE_OVERSIZE');
    return JSON.parse(raw);
  }) {
  if (!sanitize(observed)) return { error: 'COMMIT_UNVERIFIED' } satisfies PublicGitHubData;
  try {
    const branch = await request(github + '/branches/tester') as {
      commit?: { sha?: string };
    };
    const checks = await request(github + '/commits/' + short(observed) + '/check-runs?per_page=100') as {
      check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; head_sha?: string }>;
    };
    return {
      testerSha: branch?.commit?.sha,
      checks: (checks?.check_runs || []).slice(0, 100).map(x => ({
        name: x.name || '', status: x.status || '', conclusion: x.conclusion || null, sha: x.head_sha,
      })),
    } satisfies PublicGitHubData;
  } catch {
    return { error: 'PUBLIC_GITHUB_UNAVAILABLE' } satisfies PublicGitHubData;
  }
}

/** All status computations are explicit and preserve UNVERIFIED as an incomplete gate. */
export function composeRuntimeHealthReport(input: {
  runtimeCommit: string; service: string; deploymentMode: 'public' | 'private';
  canonical?: { head: string; body: string; footer: string };
  cli?: { version: string; sha256: string; commands: Record<string, unknown> };
  profile?: Parameters<typeof buildNyxRuntimeChecklist>[0]['profile'];
  effectiveCommands?: string[];
}, data: PublicGitHubData) {
  const checklist = buildNyxRuntimeChecklist({
    runtimeCommit: input.runtimeCommit,
    ...(input.deploymentMode === 'public' ? { privateBootstrapUnavailable: true } :
      { canonical: input.canonical, cli: input.cli, profile: input.profile,
        effectiveCommands: input.effectiveCommands }),
  });
  const result = assessGitHubEvidence(input.runtimeCommit, data);
  const commit = checklist.checks.find(x => x.id === 'deployment.commit');
  if (commit) {
    commit.status = result.commit.status;
    commit.evidence = result.commit.evidence;
    commit.details = result.commit.details;
  }
  checklist.checks.push({ id: 'ci.workflow', ...result.ci });
  const summary = { pass: 0, warn: 0, fail: 0, unverified: 0 };
  for (const c of checklist.checks) {
    if (c.status === 'PASS') summary.pass++;
    else if (c.status === 'WARN') summary.warn++;
    else if (c.status === 'FAIL') summary.fail++;
    else summary.unverified++;
  }
  checklist.summary = summary;
  checklist.overall = summary.fail ? 'BLOCKED' : summary.warn || summary.unverified ? 'NEEDS_REVIEW' : 'READY';
  return {
    ...checklist,
    schema: 'nyx.runtime-checklist.v2',
    service: input.service.slice(0, 80),
    mode: input.deploymentMode,
    source: 'running-process-and-exact-sha-public-github-check-runs',
    testCaseCounts: { passed: null, failed: null, skipped: null,
      reason: 'GitHub check-run conclusions do not include test-case counts; exact-SHA test-summary artifact pending.' },
  };
}
