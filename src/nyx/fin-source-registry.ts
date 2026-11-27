import { createHash } from 'node:crypto';
import type { FinSourceInspection } from './fin-source-inspection';
import { reconcileFinSourcePins } from './fin-source-inspection';

const SHA=/^[a-f0-9]{64}$/;
export type CoreKind='head'|'body'|'footer';
export type CorePointer={file:string;driveId:string;sha256:string;status:string};
export type VerifiedRegistry={
  schema:'nyx.fin.registry-inspection.v1';
  sourceKind:'registry';
  pathBasename:'n_paths.json';
  sha256:string;
  bytes:number;
  pointers:Record<CoreKind,CorePointer>;
  sourceAuthenticatedBy:'owner-authorized-provider-read';
  latestDriveScanVerified:false;
  canonicalAuthorityVerified:false;
};
/** Read exact authenticated provider bytes. Parsing or comparing an n_paths
 * copy never proves it is the newest canonical routing file.
 */
export function inspectNPathsRegistry(bytes:Buffer,relativePath:string):VerifiedRegistry {
  if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>2*1024*1024||
     typeof relativePath!=='string'||!/(^|\/)n_paths\.json$/.test(relativePath)||
     relativePath.startsWith('/')||relativePath.split('/').some(v=>!v||v==='.'||v==='..'))
    throw Error('FIN_REGISTRY_SOURCE_INVALID');
  let value:any;
  try{value=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('FIN_REGISTRY_JSON_INVALID');}
  if(value?.schema!=='nyx.filefilter_paths.normal.v1'||!value.canonical_current)
    throw Error('FIN_REGISTRY_STRUCTURE_INVALID');
  const pointers={} as Record<CoreKind,CorePointer>;
  for(const kind of ['head','body','footer'] as const){
    const c=value.canonical_current[kind];
    const pattern=kind==='head'?/^head_db_v[0-9]{3}\.zip$/:
      kind==='body'?/^body_db_v[0-9]{3}\.zip$/:
      /^footer_(?:db|mdb)_v[0-9]{3}\.zip$/;
    if(!c||typeof c.file!=='string'||!pattern.test(c.file)||
       typeof c.sha256!=='string'||!SHA.test(c.sha256)||
       typeof c.drive_id!=='string'||!/^[A-Za-z0-9_-]{10,160}$/.test(c.drive_id)||
       c.status!=='canonical_current_exact_can')
      throw Error('FIN_REGISTRY_POINTER_INVALID');
    pointers[kind]={file:c.file,driveId:c.drive_id,sha256:c.sha256,status:c.status};
  }
  return {
    schema:'nyx.fin.registry-inspection.v1',sourceKind:'registry',
    pathBasename:'n_paths.json',
    sha256:createHash('sha256').update(bytes).digest('hex'),
    bytes:bytes.length,pointers,
    sourceAuthenticatedBy:'owner-authorized-provider-read',
    latestDriveScanVerified:false,canonicalAuthorityVerified:false,
  };
}

export function reconcileRegistryAgainstBundles(
  registry:VerifiedRegistry|null,sources:FinSourceInspection[],
) {
  const internal=reconcileFinSourcePins(sources);
  if(!registry)return {
    ...internal,registryPresent:false,registryMatchesBundles:false,
    canonicalCurrentness:'NOT_VERIFIED' as const,
    verifiedCoreClassNames:[] as CoreKind[],
  };
  if(registry.sourceKind!=='registry'||registry.canonicalAuthorityVerified!==false)
    throw Error('FIN_REGISTRY_AUTHORITY_FORGERY');
  const selected=new Map(sources.filter(s=>
    s.sourceKind==='head'||s.sourceKind==='body'||s.sourceKind==='footer'
  ).map(s=>[s.sourceKind,s]));
  const matches:CoreKind[]=[];
  for(const kind of ['head','body','footer'] as const){
    const actual=selected.get(kind);
    const pin=registry.pointers[kind];
    if(actual){
      if(actual.pathBasename!==pin.file||actual.sha256!==pin.sha256)
        throw Error('FIN_REGISTRY_POINTER_MISMATCH');
      matches.push(kind);
    }
  }
  const footer=selected.get('footer');
  if(footer?.footerDeclaredPins){
    for(const kind of ['head','body'] as const){
      const pin=footer.footerDeclaredPins[kind];
      if(pin && (pin.file!==registry.pointers[kind].file||
        pin.sha256!==registry.pointers[kind].sha256))
        throw Error('FIN_FOOTER_REGISTRY_DIVERGENCE');
    }
  }
  return {
    ...internal,registryPresent:true,
    registryMatchesBundles:matches.length===3,
    verifiedCoreClassNames:matches,
    canonicalCurrentness:'POINTER_CONSISTENT_LATEST_UNVERIFIED' as const,
    // Requires independent canonical Drive folder discovery and revision read.
    canonicalAuthorityVerified:false,
  };
}
