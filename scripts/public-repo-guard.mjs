import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CANONICAL_REPO = 'yaMorozYaroslav/YaRoute';
const historyMode = process.argv.includes('--history');

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function looksBinary(buffer) {
  return buffer.includes(0);
}

function forbiddenFilename(file) {
  const name = file.toLowerCase();
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (name.endsWith('/rclone.conf') || name === 'rclone.conf') return true;
  if (/\.(pem|key|p12|pfx|b64)$/.test(name)) return true;
  if (/(^|\/)(credentials|secrets)[^/]*\.json$/.test(name)) return true;
  return false;
}

const secretPatterns = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['literal bearer token', /Authorization:\s*Bearer\s+(?!<|\$)[A-Za-z0-9._~-]{24,}/i],
];

const forbiddenPublicIdentifiers = [
  'linuxofpower/NestNyx',
  'linuxofpower/NyxGPT',
];

const allowedEmailDomains = new Set(['example.com', 'users.noreply.github.com']);
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

function scanCurrent() {
  const failures = [];
  const files = trackedFiles();

  for (const file of files) {
    if (forbiddenFilename(file)) {
      failures.push(`forbidden tracked filename: ${file}`);
      continue;
    }

    const buffer = fs.readFileSync(file);
    if (looksBinary(buffer)) continue;
    const text = buffer.toString('utf8');

    if (file !== 'scripts/public-repo-guard.mjs') {
      for (const [label, pattern] of secretPatterns) {
        if (pattern.test(text)) failures.push(`${label} pattern in ${file}`);
      }
    }

    if (file !== 'scripts/public-repo-guard.mjs') {
      for (const id of forbiddenPublicIdentifiers) {
        if (text.includes(id)) failures.push(`noncanonical/private repository identifier in ${file}`);
      }
    }

    if (text.includes('linuxofpower') && file !== 'scripts/public-repo-guard.mjs') {
      failures.push(`private account identifier in ${file}`);
    }

    let match;
    emailPattern.lastIndex = 0;
    while ((match = emailPattern.exec(text))) {
      const domain = match[1].toLowerCase();
      if (!allowedEmailDomains.has(domain)) {
        failures.push(`personal email address in ${file}`);
        break;
      }
    }
  }

  const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  if (app.repository !== `https://github.com/${CANONICAL_REPO}`) {
    failures.push('app.json repository is not the canonical YaRoute repository');
  }

  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== CANONICAL_REPO) {
    failures.push(`workflow is running in noncanonical repository: ${process.env.GITHUB_REPOSITORY}`);
  }

  if (failures.length) {
    console.error('Public-repository guard FAILED:');
    for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Public-repository guard passed for ${CANONICAL_REPO}.`);
}

function scanHistory() {
  // History scan deliberately uses only high-confidence secret signatures.
  // It prints commit/path locations, never matching secret values.
  const commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
  const ere = [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'github_pat_[A-Za-z0-9_]{20,}',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'AIza[0-9A-Za-z_-]{20,}',
    'AKIA[0-9A-Z]{16}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
  ].join('|');

  const failures = [];
  for (const commit of commits) {
    try {
      const out = git([
        'grep', '-I', '-l', '-E', ere, commit, '--', '.',
        ':(exclude)scripts/public-repo-guard.mjs',
      ]).trim();
      if (out) failures.push(...out.split('\n'));
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }

  const names = git(['log', '--all', '--name-only', '--pretty=format:'])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const file of names) {
    if (forbiddenFilename(file)) failures.push(`historical sensitive filename: ${file}`);
  }

  if (failures.length) {
    console.error('Git-history secret audit FAILED. Locations only; secret values are redacted:');
    for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('Git-history high-confidence secret audit passed.');
}

scanCurrent();
if (historyMode) scanHistory();
