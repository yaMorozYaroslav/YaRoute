import { createHash } from 'node:crypto';
import path from 'node:path';

export type FinSourceKind = 'head'|'body'|'footer'|'pending_keys'|'lcb';
export interface FinSourceInspection {
  schema:'nyx.fin.source-inspection.v1';
  sourceKind:FinSourceKind;
  pathBasename:string;
  bytes:number;
  sha256:string;
  structuralChecks:'PASS';
  declaredVersion:string|null;
  claimedCanonicalCurrent:false;
  sourceAuthenticatedBy:'owner-authorized-provider-read';
  /** Footer pins are only declared pointers; never independently verified currentness. */
  footerDeclaredPins?:{
    head:{file:string;sha256:string}|null;
    body:{file:string;sha256:string}|null;
  };
  /** This must remain false until current canonical n_paths/Drive pointer is verified. */
  canonicalAuthorityVerified:false;
}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
function safePin(value:unknown){
  if(!value||typeof value!=='object')return null;
  const obj=value as Record<string,unknown>;
  return typeof obj.file==='string' && obj.file.length<=100 &&
    typeof obj.sha256==='string'&&SHA.test(obj.sha256) ?
    {file:obj.file,sha256:obj.sha256}:null;
}
const MAX_ENTRY=2*1024*1024;
const MAX_ARCHIVE_TOTAL=96*1024*1024;
/** Inspect verified source bytes, not the caller's claimed metadata. Never
 * return source contents or claim a bundle is the newest canonical version.
 */

/** Checks authentic provider-read bundle bytes against the pointer INSIDE a
 * supplied Footer. It does NOT prove that this Footer is the newest canonical.
 */
export function reconcileFinSourcePins(sources:FinSourceInspection[]) {
  if(!Array.isArray(sources)||sources.length>8)
    throw Error('FIN_SOURCE_SET_INVALID');
  const chosen=new Map<FinSourceKind,FinSourceInspection>();
  for(const s of sources){
    if(chosen.has(s.sourceKind))
      throw Error('FIN_SOURCE_CLASS_DUPLICATE');
    chosen.set(s.sourceKind,s);
  }
  const footer=chosen.get('footer');
  const head=chosen.get('head'),body=chosen.get('body');
  const checks=[
    {kind:'head' as const,seen:head,pin:footer?.footerDeclaredPins?.head},
    {kind:'body' as const,seen:body,pin:footer?.footerDeclaredPins?.body},
  ];
  for(const {seen,pin} of checks){
    if(seen && footer && pin &&
       (seen.pathBasename!==pin.file||seen.sha256!==pin.sha256))
      throw Error('FIN_SOURCE_PIN_MISMATCH');
  }
  const matched=checks.filter(x=>x.seen && x.pin &&
    x.seen.pathBasename===x.pin.file&&x.seen.sha256===x.pin.sha256);
  return {
    schema:'nyx.fin.source-set.v1' as const,
    footerPresent:!!footer,
    verifiedSourceClasses:[...chosen.keys()],
    internallyConsistentWithFooter:matched.length===2,
    matchedPointers:matched.map(x=>x.kind),
    missingSourceClasses:['head','body','footer'].filter(c=>!chosen.has(c as FinSourceKind)),
    canonicalAuthorityVerified:false,
    canonicalCurrentness:'NOT_VERIFIED' as const,
    pendingKeysAndLcbReconciled:false,
  };
}

export function inspectFinSource(bytes:Buffer,sourceKind:FinSourceKind,
  relativePath:string):FinSourceInspection {
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>16*1024*1024)
    throw Error('FIN_SOURCE_SIZE_INVALID');
  if(typeof relativePath!=='string'||relativePath.length>2048 ||
     relativePath.includes('\\')||relativePath.startsWith('/')||
     relativePath.split('/').some(v=>v==='..'||v==='.'))
    throw Error('FIN_SOURCE_PATH_INVALID');
  const base=path.posix.basename(relativePath);
  const core=sourceKind==='head'||sourceKind==='body'||sourceKind==='footer';
  const typePrefix={
    head:'head_db',body:'body_db',footer:'footer_(?:db|mdb)',
    pending_keys:'',lcb:'',
  }[sourceKind];
  if(core&&!new RegExp('^'+typePrefix+'_v([0-9]{3})\\.zip$').test(base))
    throw Error('FIN_SOURCE_ARCHIVE_NAME_INVALID');
  if(!core&&
     !(/^[A-Za-z0-9_.-]{1,160}\.(?:json|zip)$/i.test(base)))
    throw Error('FIN_SOURCE_ARCHIVE_NAME_INVALID');
  let declaredVersion:string|null=null;
  let footerDeclaredPins:FinSourceInspection['footerDeclaredPins'];
  if(base.endsWith('.zip')){
    let zip:any;
    try{const AdmZip=require('adm-zip');zip=new AdmZip(bytes);}
    catch{throw Error('FIN_SOURCE_ZIP_INVALID');}
    const entries=zip.getEntries();
    if(!Array.isArray(entries)||!entries.length||entries.length>2500)
      throw Error('FIN_SOURCE_ZIP_INVALID');
    let total=0;
    const names=new Set<string>();
    for(const entry of entries){
      const name=entry.entryName as string;
      const size=entry.header?.size as number;
      const parts=typeof name==='string'?name.replace(/\/$/,'').split('/'):[];
      if(typeof name!=='string'||name.startsWith('/')||name.includes('\\')||
         !parts.length||parts.some(v=>v==='.'||v==='..'||v==='')||
         (name.endsWith('/')&&size!==0)||
         typeof size!=='number'||!Number.isSafeInteger(size)||size<0)
        throw Error('FIN_SOURCE_ZIP_UNSAFE');
      total+=size;
      if(total>MAX_ARCHIVE_TOTAL||names.has(name))throw Error('FIN_SOURCE_ZIP_UNSAFE');
      names.add(name);
    }
    if(core){
      const prefix=base.slice(0,-4)+'/';
      // Parent bundle filename, not an arbitrary matching file embedded elsewhere.
      const expected=sourceKind==='head'
        ?prefix+'LEAD/Core_Skills/YaRoCLI/nyxcli.json'
        :sourceKind==='footer'
         ?prefix+'001_canonical_live_state.json'
         :null;
      if(![...names].some(n=>n.startsWith(prefix))||
        (expected&&!names.has(expected)))
        throw Error('FIN_SOURCE_ARCHIVE_STRUCTURE_INVALID');
      const match=base.match(/_v([0-9]{3})\.zip$/);
      declaredVersion=match?'v'+match[1]:null;
      const target=expected?zip.getEntry(expected):null;
      if(target){
        if(target.header.size>MAX_ENTRY)
          throw Error('FIN_SOURCE_MANIFEST_TOO_LARGE');
        let data:any;
        try{data=JSON.parse(target.getData().toString('utf8'));}
        catch{throw Error('FIN_SOURCE_MANIFEST_INVALID');}
        if(sourceKind==='head' &&
           (data.schema!=='nyx.yarocli.v1'||typeof data.commands!=='object'))
          throw Error('FIN_SOURCE_MANIFEST_INVALID');
        if(sourceKind==='footer'){
          if(data.schema!=='yaro_canonical_live_state'||!data.canonical_current)
            throw Error('FIN_SOURCE_MANIFEST_INVALID');
          footerDeclaredPins={
            head:safePin(data.canonical_current.head),
            body:safePin(data.canonical_current.body),
          };
        }
      }
    }
  }else if(sourceKind==='pending_keys'){
    try{const v=JSON.parse(bytes.toString('utf8'));if(typeof v!=='object'||!v)
      throw Error('FIN_SOURCE_JSON_INVALID');}
    catch{throw Error('FIN_SOURCE_JSON_INVALID');}
  }else throw Error('FIN_SOURCE_EXPECTED_ARCHIVE');
  return {
    schema:'nyx.fin.source-inspection.v1',sourceKind,
    pathBasename:base,bytes:bytes.length,
    sha256:digest(bytes),declaredVersion,
    structuralChecks:'PASS',
    claimedCanonicalCurrent:false,
    sourceAuthenticatedBy:'owner-authorized-provider-read',
    ...(footerDeclaredPins?{footerDeclaredPins}:{}),
    canonicalAuthorityVerified:false,
  };
}
