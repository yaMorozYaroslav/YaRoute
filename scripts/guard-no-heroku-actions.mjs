import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Defense in depth: prohibit GitHub Actions from direct Heroku API/Git deployment.
 * Separate from actually removing/revoking the credential at its issuer.
 */
export function prohibitedHerokuActions(workflows) {
  const found=[];
  for(const [name,contents] of Object.entries(workflows)){
    const body=String(contents);
    if(/deploy[-_.]?heroku/i.test(name) ||
       /\bHEROKU[_-]?(?:API[_-]?KEY|TOKEN|AUTH[_-]?TOKEN)\b/i.test(body) ||
       /(?:api|git)\.heroku\.com/i.test(body) ||
       /(?:\bheroku\/deploy\b|\bheroku\s+(?:apps|addons|container|ps|formation|config|git:remote|deploy|login)\b)/i.test(body)){
      found.push(name);
    }
  }
  return found.sort();
}
function workflowsAt(root){
  if(!fs.existsSync(root))return {};
  const found={};
  for(const file of fs.readdirSync(root)){
    if(!/\.ya?ml$/i.test(file))continue;
    found[file]=fs.readFileSync(path.join(root,file),'utf8');
  }
  return found;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bad=prohibitedHerokuActions(workflowsAt(path.resolve('.github/workflows')));
  if(bad.length){
    process.stderr.write('HEROKU_DEPLOYMENT_WORKFLOW_FORBIDDEN: '+bad.join(', ')+'\n');
    process.exitCode=1;
  }else{
    process.stdout.write('No GitHub Actions Heroku deployment credentials or operations detected.\n');
  }
}
