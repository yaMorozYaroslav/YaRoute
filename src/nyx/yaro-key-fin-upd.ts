import { createHash } from 'node:crypto';
import type { KeyCandidate } from './key-engine';

/** Canonical authority: Head v032, LEAD/Core_Skills/YaRoCLI/nyxcli.json.
 * oFxS is an explicitly accepted but not-yet-canonical KEY-only adapter alias.
 * No general-purpose interpretation of xS is introduced here.
 */
export type YaroStage = 'key_oF' | 'key_oS' | 'fin' | 'upd';
export type KeyScope = 'local' | 'global';
export type KeyTarget = 'head' | 'body' | 'footer';
export type KeyStatus = 'implemented_now' | 'queued_for_target_bundle' |
  'blocked_with_reason' | 'preserved_pending_decision';
export type SourceClass = 'current_chat' | 'head' | 'body' | 'footer' |
  'active_keys' | 'pending_keys' | 'lcb';
export interface SourceReceipt {
  sourceClass: SourceClass;
  ref: string;
  sha256: string;
  /** True only when a trusted runtime adapter checked exact source bytes. */
  verifiedByAdapter: boolean;
}
export interface KeyDisposition {
  id: string;
  target: KeyTarget;
  status: KeyStatus;
  reason: string;
  /** Exact target-specific instructions, not just a generic label. */
  instructions: string[];
  source: string;
}
export interface YaroCommandSequence {
  normalized: string;
  scope: KeyScope;
  stages: YaroStage[];
  pendingAlias: boolean;
}
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
const validSha=/^[a-f0-9]{64}$/;
const statusSet=new Set<KeyStatus>(['implemented_now','queued_for_target_bundle',
  'blocked_with_reason','preserved_pending_decision']);
const requiredBaseline:SourceClass[]=['current_chat','head','body','footer'];
const globalExtras:SourceClass[]=['active_keys','pending_keys','lcb'];

export function parseKeyFinUpdCommand(input:string):YaroCommandSequence {
  if(typeof input!=='string'||input.length<8||input.length>240)
    throw Error('YARO_COMMAND_INVALID');
  // A separated x S is not a Yaro command. Never normalize it into the
  // pending KEY-local oFxS shorthand.
  if(/x\s+S(?=\s|x|$)/i.test(input))throw Error('YARO_COMMAND_SEQUENCE_INVALID');
  const compact=input.replace(/\s+/g,'');
  // Existing Dev-only KEY single-command aliases. These do not globalize
  // later commands: a global multi-command chain must still use terminal Go.
  const keyOnly=/^nyxkeyofxs([gl])$/i.exec(compact);
  if(keyOnly)return {
    normalized:keyOnly[1].toLowerCase()==='g'?'NyxkeyoFxkeyoSGo':'NyxkeyoFxkeyoS',
    scope:keyOnly[1].toLowerCase()==='g'?'global':'local',
    stages:['key_oF','key_oS'],pendingAlias:true,
  };
  const global=/go$/i.test(compact);
  const scope:KeyScope=global?'global':'local';
  const base=global?compact.slice(0,-2):compact;
  if(!/^nyx/i.test(base))throw Error('YARO_COMMAND_INVALID');
  const x=base.slice(3).toLowerCase();
  const starts:string[]=['keyofxs','keyofxos','keyofxkeyos'];
  const prefix=starts.find(v=>x.startsWith(v));
  let stages:YaroStage[]=[];
  let alias=false;
  if(prefix){
    const rest=x.slice(prefix.length);
    if(!['','xfin','xfinxupd'].includes(rest))
      throw Error('YARO_COMMAND_SEQUENCE_INVALID');
    alias=prefix!=='keyofxkeyos';
    stages=['key_oF','key_oS'];
    if(rest.startsWith('xfin'))stages.push('fin');
    if(rest.endsWith('xupd'))stages.push('upd');
  }else if(x==='fin'||x==='finxupd') {
    stages=['fin',...(x.endsWith('xupd')?['upd' as const]:[])];
  }else if(x==='upd') {
    // An isolated UPD can be parsed but MUST fail the same-chat FIN gate.
    stages=['upd'];
  }else throw Error('YARO_COMMAND_SEQUENCE_INVALID');
  const normalized='Nyx'+stages.map((s,i)=>i===0
    ?(s==='key_oF'?'keyoF':s==='fin'?'fin':'upd')
    :(s==='key_oS'?'xkeyoS':'x'+s)).join('')+(global?'Go':'');
  if(stages.includes('key_oS')&&!stages.includes('key_oF'))
    throw Error('YARO_COMMAND_SEQUENCE_INVALID');
  return {normalized,scope,stages,pendingAlias:alias};
}

function normalizeCandidates(candidates:KeyCandidate[]):KeyCandidate[] {
  if(!Array.isArray(candidates)||candidates.length>2000)
    throw Error('YARO_KEY_INVENTORY_INVALID');
  const seen=new Map<string,KeyCandidate>();
  for(const candidate of candidates) {
    if(!candidate||!['head','body','footer'].includes(candidate.target)||
       !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.id)||
       typeof candidate.description!=='string'||!candidate.description.trim()||
       typeof candidate.source!=='string'||!candidate.source.trim()||
       !Number.isFinite(candidate.confidence)||candidate.confidence<0||
       candidate.confidence>1)
      throw Error('YARO_KEY_INVENTORY_INVALID');
    const k=candidate.target+':'+candidate.id;
    const existing=seen.get(k);
    if(existing) {
      // A repeated ID may have higher confidence, but cannot silently change
      // its meaning or its source. That requires an explicit supersession.
      if(existing.description!==candidate.description||existing.source!==candidate.source)
        throw Error('YARO_KEY_PROVENANCE_CONFLICT');
      if(candidate.confidence>existing.confidence)seen.set(k,candidate);
    }else seen.set(k,candidate);
  }
  return [...seen.values()].sort((a,b)=>a.target.localeCompare(b.target)||
    a.id.localeCompare(b.id));
}

function validateEvidence(scope:KeyScope,receipts:SourceReceipt[]):{
  missing:SourceClass[];
  verified:SourceReceipt[];
} {
  const required=[...requiredBaseline,...(scope==='global'?globalExtras:[])];
  const found=new Map<SourceClass,SourceReceipt>();
  for(const receipt of receipts){
    if(!required.includes(receipt.sourceClass))continue;
    if(found.has(receipt.sourceClass))throw Error('YARO_SOURCE_RECEIPT_DUPLICATE');
    found.set(receipt.sourceClass,receipt);
  }
  const verified=required.map(k=>found.get(k)).filter((r):r is SourceReceipt=>
    !!r&&r.verifiedByAdapter===true&&typeof r.ref==='string'&&r.ref.length>0&&
    validSha.test(r.sha256));
  return {missing:required.filter(k=>!verified.some(r=>r.sourceClass===k)),verified};
}

/** Pure same-chat planner. Caller MUST supply adapter-verified source receipts;
 * public MCP deliberately has no private source adapter and may only preflight.
 */
export function finalizeYaroPlanning(input:{
  scope:KeyScope;
  executionId:string;
  candidates:KeyCandidate[];
  sourceReceipts:SourceReceipt[];
  dispositions?:KeyDisposition[];
}) {
  if(!/^[A-Za-z0-9_-]{1,73}$/.test(input.executionId))
    throw Error('YARO_EXECUTION_ID_INVALID');
  const candidates=normalizeCandidates(input.candidates);
  const evidence=validateEvidence(input.scope,input.sourceReceipts);
  const supplied=input.dispositions||[];
  const byKey=new Map<string,KeyDisposition>();
  for(const d of supplied){
    if(!d||!statusSet.has(d.status)||!['head','body','footer'].includes(d.target)||
       typeof d.reason!=='string'||!d.reason.trim()||
       !Array.isArray(d.instructions)||d.instructions.some(v=>
         typeof v!=='string'||!v.trim())||
       typeof d.source!=='string'||!d.source.trim())
      throw Error('YARO_DISPOSITION_INVALID');
    const k=d.target+':'+d.id;
    if(byKey.has(k)||!candidates.some(c=>c.id===d.id&&c.target===d.target&&c.source===d.source))
      throw Error('YARO_DISPOSITION_SOURCE_MISMATCH');
    if((d.status==='implemented_now'||d.status==='queued_for_target_bundle')&&
       !d.instructions.length)
      throw Error('YARO_DISPOSITION_INSTRUCTIONS_MISSING');
    byKey.set(k,d);
  }
  const missingDispositions=candidates.filter(c=>!byKey.has(c.target+':'+c.id))
    .map(c=>c.target+':'+c.id);
  const unresolved=candidates.filter(c=>{
    const d=byKey.get(c.target+':'+c.id);
    return c.blocked===true || c.confidence<0.8 ?
      !d || (d.status!=='blocked_with_reason'&&d.status!=='preserved_pending_decision'):
      false;
  }).map(c=>c.target+':'+c.id);
  const ready=evidence.missing.length===0&&missingDispositions.length===0&&
    unresolved.length===0;
  // Preserve all candidate references even when execution is blocked. These
  // are provisional classifications, never successful implicit dispositions.
  const keyUtilization=candidates.map(c=>byKey.get(c.target+':'+c.id)??{
    id:c.id,target:c.target,status:'blocked_with_reason' as const,
    reason:'Missing verified authoritative sources or exact disposition',
    instructions:[],source:c.source,
  });
  const result={
    schema:'nyx.yaro.fin.v1' as const,
    status:ready?'FIN_PASS' as const:'PARTIAL_DIAGNOSTIC' as const,
    phase:ready?'VERIFY' as const:'RESOLVE' as const,
    scope:input.scope,
    planningMode:'shared_cross_core_blueprint' as const,
    sameChatExecutionId:input.executionId,
    selectedGenerationCore:null,
    sourceEvidence:evidence.verified,
    missingSourceClasses:evidence.missing,
    missingDispositions,
    unresolved,
    keyUtilization,
    headSlice:keyUtilization.filter(x=>x.target==='head'),
    bodySlice:keyUtilization.filter(x=>x.target==='body'),
    footerContinuity:keyUtilization.filter(x=>x.target==='footer'),
    canonicalChanged:false,
    persisted:false,
    finSeedCandidate:ready?'fin_seed_g_candidate_unversioned':null,
    provenanceDigest:sha256(JSON.stringify({
      candidates,keyUtilization,sources:evidence.verified,scope:input.scope,
    })),
  };
  return result;
}

export function updateYaroPlanning(input:{
  fin:ReturnType<typeof finalizeYaroPlanning>;
  executionId:string;
}) {
  if(input.fin.status!=='FIN_PASS'||
     input.fin.sameChatExecutionId!==input.executionId)
    return {
      schema:'nyx.yaro.upd.v1' as const,
      status:'BLOCKED_FIN_PRECONDITION' as const,
      phase:'RESOLVE' as const,
      sameChatFinVerified:false,
      keyUtilization:input.fin.keyUtilization,
      headInstructions:[],
      bodyInstructions:[],
      seedCandidate:null,
      canonicalChanged:false,persisted:false,
    };
  const enabled=(x:KeyDisposition)=>x.status==='implemented_now'||
    x.status==='queued_for_target_bundle';
  return {
    schema:'nyx.yaro.upd.v1' as const,
    status:'UPD_PASS_UNPERSISTED' as const,
    phase:'VERIFY' as const,
    sameChatFinVerified:true,
    finProvenanceDigest:input.fin.provenanceDigest,
    keyUtilization:input.fin.keyUtilization,
    headInstructions:input.fin.headSlice.filter(enabled).flatMap(x=>x.instructions),
    bodyInstructions:input.fin.bodySlice.filter(enabled).flatMap(x=>x.instructions),
    seedCandidate:'seed_g_candidate_unversioned',
    canonicalChanged:false,persisted:false,
  };
}

/** Before a verified global source adapter exists, report exactly what is
 * missing. A boolean from the MCP caller MUST NOT be accepted as evidence.
 */
export function publicFinUpdPreflight(input:{
  scope:KeyScope;executionId:string;candidates:KeyCandidate[];
  hasExplicitChatMessages:boolean;
  /** Only server-derived reads may reach this parameter; NEVER model input. */
  verifiedSourceReceipts?:SourceReceipt[];
  dispositions?:KeyDisposition[];
}) {
  const fin=finalizeYaroPlanning({
    scope:input.scope,executionId:input.executionId,candidates:input.candidates,
    sourceReceipts:input.verifiedSourceReceipts??[],
    dispositions:input.dispositions??[],
  });
  const upd=updateYaroPlanning({fin,executionId:input.executionId});
  return {
    schema:'nyx.yaro.chain-preflight.v1' as const,
    status:'PARTIAL_DIAGNOSTIC' as const,
    fin,upd,
    sourceCoverage:{
      explicitMessages:input.hasExplicitChatMessages?'supplied_not_full_chat':'none',
      tenantKey:input.verifiedSourceReceipts?.some(x=>x.sourceClass==='active_keys')
        ?'owner_scoped_readback_verified':'not_verified',
      canonicalHeadBodyFooter:input.verifiedSourceReceipts?.filter(x=>
        ['head','body','footer'].includes(x.sourceClass)).map(x=>x.sourceClass)??[],
      pendingKeyAndLCB:'not_globally_reconciled',
    },
    nextAction:'Resolve current Head, Body, Footer, pending keys and relevant LCBs through separately authorized adapters; complete provenance-preserving dispositions before FIN/UPD',
    noCanonicalChanges:true,
  };
}
