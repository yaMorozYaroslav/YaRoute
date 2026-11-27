import { createHash } from 'node:crypto';
import type { KeyCandidate } from './key-engine';

/**
 * Conservative extraction of EXPLICIT caller-supplied user decisions.
 * A KEY command or a request to test something is NOT itself a change decision.
 * This never loads ChatGPT history or external files and must not claim that it does.
 */
export type KeyChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  id?: string;
};
export type KeyChatSignal = KeyCandidate & {
  evidence: { message: string; excerpt: string };
};

const unsafe = /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{10,}|\b(?:password|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|api[ _-]?key|authorization)\s*[:=]\s*["']?\S+|\bBearer\s+[A-Za-z0-9._-]{16,}|\bAIza[A-Za-z0-9_-]{20,})/i;
const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const phone = /\+?\d[\d ()\-]{9,}\d/g;

// "test" and "verify" are diagnostics, not change verbs. Do not turn them
// into pending Head changes simply because a user asked to inspect a feature.
const mutation = '(?:implement|fix|repair|add|create|build|update|change|replace|enable|disable|reconcile|synchronize|sync|migrate|preserve|prevent|remove|extract|configure|record|route|integrate|introduce|require|enforce|rename|store|keep|use)';
const imperative = new RegExp('^(?:(?:yes|okay|ok|please|now|also|and|then)[,!]?\\s+)*(?:'+mutation+')\\b','i');
const explicitRequest = new RegExp('\\b(?:please\\s+|(?:i|we)\\s+(?:want|need)\\s+(?:you\\s+)?to\\s+|(?:you|we|it|this|the\\s+(?:backend|cli|system|app|service|head|body|footer))\\s+(?:must|have\\s+to|need\\s+to)\\s+)(?:not\\s+)?'+mutation+'\\b','i');
const strongRequirement = new RegExp('^(?:(?:we|you|it|this|the\\s+\\w+)\\s+)?(?:must|need(?:s)?\\s+to|have\\s+to)\\s+(?:not\\s+)?'+mutation+'\\b','i');
const softRequirement = new RegExp('^(?:(?:we|you|it|this|the\\s+\\w+)\\s+)?should\\s+(?:not\\s+)?'+mutation+'\\b','i');
const negativeDirective = new RegExp('^(?:do\\s+not|don.t|never)\\s+'+mutation+'\\b','i');
const accepted = /^(?:yes|approved|accepted|confirmed|agreed|decided)(?:[:,!\s]|$)/i;
const diagnostic = /^(?:(?:okay|ok|please|now|so)[,!\s]+)*(?:test|check|verify|explain|tell|list|inspect|show|describe|review|summarize|compare|report|analyze|audit|confirm|find out)\b/i;
const diagnosticWithChange = new RegExp('\\b(?:and|then)\\s+'+mutation+'\\b','i');
const hypothetical = /^(?:(?:well|so|we|i)[,!\s]+)?(?:could|might|maybe|perhaps|what if|would it|should we|can we|i wonder)\b/i;
const retrospective = /^(?:(?:okay|ok|please|now)[,!\s]+)*make sure\s+(?:you\s+)?(?:already\s+)?(?:implemented|deployed|completed|ran|did|fixed|updated)\b/i;
const commandOnly = /^(?:nyx\s*key|nyxkey)\s*o[a-z]+(?:\s*x\s*(?:key\s*)?o[a-z]+)*\s*(?:go|gno)?$/i;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function safeText(s: string): string {
  return normalize(s).replace(email,'[email]').replace(phone,'[phone]').slice(0,300);
}
function targetFor(s: string): KeyCandidate['target'] {
  // A backend request about a transaction receipt is still a Head/code request,
  // not a Footer write. Explicit Footer data work wins when it is not code work.
  const technical=/\b(?:nestnyx|backend|code|cli|parser|extractor|mcp|api|tool|deployment|devops|runtime)\b/i.test(s);
  if (/\bfooter\b/i.test(s) && !technical) return 'footer';
  if (technical || /\bhead\b/i.test(s)) return 'head';
  if (/\b(?:body|todo|note|task|career|life|knowledge)\b/i.test(s)) return 'body';
  if (/\b(?:footer|snapshot|checkpoint|manifest|continuity)\b/i.test(s)) return 'footer';
  return 'head';
}
const ignoredReasonKeys = ['assistant','quotedOrCode','commandOnly','diagnostic','hypothetical','retrospective','nonDirective','duplicate'] as const;
type IgnoredReason = typeof ignoredReasonKeys[number];
type IgnoredReasons = Record<IgnoredReason,number>;

export function extractKeySignals(messages: KeyChatMessage[]): {
  schema: 'nyx.key.chat-extraction.v1';
  status: 'PROPOSAL_ONLY';
  candidates: KeyChatSignal[];
  suppliedMessageCount: number;
  ignored: number;
  ignoredReasons: IgnoredReasons;
  textAccess: 'explicit-supplied-only';
} {
  if (!Array.isArray(messages) || !messages.length || messages.length > 80)
    throw Error('KEY_CHAT_INPUT_BOUNDS');
  if (messages.some(m => !m || !['user','assistant'].includes(m.role) ||
    typeof m.text !== 'string' || m.text.length > 6000 || (m.id !== undefined &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(m.id))))
    throw Error('KEY_CHAT_INPUT_INVALID');
  if (messages.reduce((n,m) => n + m.text.length,0) > 48000)
    throw Error('KEY_CHAT_INPUT_BOUNDS');
  // Reject the entire batch before deriving, logging or storing any candidates.
  if (messages.some(m => unsafe.test(m.text))) throw Error('KEY_CHAT_UNSAFE_INPUT');
  const out: KeyChatSignal[] = [];
  const seen = new Set<string>();
  const ignoredReasons=Object.fromEntries(ignoredReasonKeys.map(k=>[k,0])) as IgnoredReasons;
  let ignored=0;
  const skip=(reason:IgnoredReason)=>{ignored++;ignoredReasons[reason]++;};
  messages.forEach((message,index)=>{
    if (message.role!=='user') {skip('assistant');return;}
    let fenced=false;
    for (const rawLine of message.text.split(/\n/)) {
      if (/^\s*(?:`{3}|~{3})/.test(rawLine)) {fenced=!fenced;skip('quotedOrCode');continue;}
      if (fenced || /^\s*>/.test(rawLine)) {skip('quotedOrCode');continue;}
      for (const part of rawLine.split(/(?<=[.!?])\s+(?=[A-Z])/)){
        const line=normalize(part.replace(/^\s*(?:[-*]|\d+[.)])\s*/,''));
        if (!line || line.length<12) {skip('nonDirective');continue;}
        if (commandOnly.test(line)) {skip('commandOnly');continue;}
        if (hypothetical.test(line)) {skip('hypothetical');continue;}
        if (retrospective.test(line)) {skip('retrospective');continue;}
        if (diagnostic.test(line) && !diagnosticWithChange.test(line)) {
          skip('diagnostic');continue;
        }
        const direct=imperative.test(line)||explicitRequest.test(line)||negativeDirective.test(line);
        const firm=strongRequirement.test(line);
        const soft=softRequirement.test(line);
        const confirmed=accepted.test(line)&&new RegExp('\\b'+mutation+'\\b','i').test(line);
        if (!direct&&!firm&&!soft&&!confirmed) {skip('nonDirective');continue;}
        const description=safeText(line);
        if (description.length<12) {skip('nonDirective');continue;}
        const target=targetFor(description);
        const fingerprint=createHash('sha256').update(target+':'+
          description.toLowerCase().replace(/[^a-z0-9]+/g,' ')).digest('hex').slice(0,16);
        if(seen.has(fingerprint)){skip('duplicate');continue;}
        seen.add(fingerprint);
        const confidence=direct?0.94:confirmed?0.92:firm?0.88:0.70;
        out.push({
          id:'chat_'+fingerprint,target,description,confidence,
          blocked:confidence<0.8,source:'chat:user:'+(message.id||String(index+1)),
          evidence:{message:message.id||String(index+1),excerpt:description},
        });
        if(out.length>40)throw Error('KEY_CHAT_CANDIDATES_OVERFLOW');
      }
    }
  });
  out.sort((a,b)=>b.confidence-a.confidence||a.id.localeCompare(b.id));
  return {schema:'nyx.key.chat-extraction.v1',status:'PROPOSAL_ONLY',
    candidates:out,suppliedMessageCount:messages.length,
    ignored,ignoredReasons,textAccess:'explicit-supplied-only'};
}
