import { readFileSync } from 'node:fs';
import { privateReleaseConditions } from './private-release-conditions.mjs';
const path=process.argv[2];
if(!path){
  console.error('PRIVATE_RELEASE_CONFIG_PATH_REQUIRED');
  process.exit(2);
}
try{
  const data=JSON.parse(readFileSync(path,'utf8'));
  const failures=privateReleaseConditions(data);
  if(failures.length){
    // Only generic safe codes; never print key names with their values.
    console.error('Private release preflight rejected: '+failures.join(', '));
    process.exitCode=1;
  }else{
    console.log('Private runtime release prerequisites verified.');
  }
}catch{
  console.error('PRIVATE_RELEASE_CONFIG_UNREADABLE');
  process.exitCode=1;
}
