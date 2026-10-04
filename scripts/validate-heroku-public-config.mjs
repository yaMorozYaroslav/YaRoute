import fs from 'node:fs';

const file = process.argv[2] || 'config/heroku-public.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const allowed = new Set([
  'NYX_PUBLIC_URL',
  'NYX_OAUTH_AUDIENCE',
  'NYX_OAUTH_SCOPES',
  'NYX_INIT_AREA',
  'NYX_NORMAL_PATHS_PATH',
  'NYX_AREAS_ROOT_PATH',
  'NYX_YARO_PREFIX',
  'NYX_GLOBAL_INDEX_ON_BOOT',
]);

const forbiddenKey = /(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|API_KEY|RCLONE|DATABASE|SHARED_ROOTS|CLIENT_SECRET)/i;
const suspiciousValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
];

const failures = [];

if (!data || Array.isArray(data) || typeof data !== 'object') {
  failures.push('config must be a JSON object');
} else {
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.has(key)) failures.push(`key is not allow-listed: ${key}`);
    if (forbiddenKey.test(key)) failures.push(`secret/private key class is forbidden: ${key}`);
    if (typeof value !== 'string') {
      failures.push(`${key} must have a string value`);
      continue;
    }
    if (value.length > 2048) failures.push(`${key} is too long for public config`);
    for (const pattern of suspiciousValuePatterns) {
      if (pattern.test(value)) {
        failures.push(`${key} looks like secret material`);
        break;
      }
    }
  }
}

if (failures.length) {
  console.error('Heroku public config validation FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Heroku public config validated: ${Object.keys(data).sort().join(', ')}`);
