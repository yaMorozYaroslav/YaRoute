import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
let commit = process.env.SOURCE_VERSION || process.env.HEROKU_SLUG_COMMIT;
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
}
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/build-info.json', JSON.stringify({ commit: /^[a-f0-9]{40}$/.test(commit || '') ? commit : null }) + '\n');
