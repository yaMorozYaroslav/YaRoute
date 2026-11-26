import { createHash } from 'node:crypto';
import type { KeyCandidate } from './key-engine';

/**
 * Extract operator decisions from an EXPLICIT, bounded chat excerpt.
 * This code never reads ChatGPT history, account data or hidden model context.
 * Only user-authored messages can produce candidate KEY mutations.
 */
export type KeyChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  id?: string;
};
export type KeyChatSignal = KeyCandidate & {
  evidence: { message: string; excerpt: string };
};

const unsafe = /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{10,}|\b(?:password|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|api[ _-]?key|authorization)\s*[:=]\s*\S+)/i;
const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const phone = /\+?\d[\d ()\-]{9,}\d/g;
const action = /\b(?:implement|fix|repair|deploy|test|add|create|build|update|change|replace|verify|enable|disable|reconcile|synchronize|sync|migrate|preserve|prevent|remove|extract|make|ensure|must|need to|should)\b/i;
const decision = /\b(?:approved?|agreed|decided|confirmed|accepted)\b/i;
const speculative = /^(?:what if|could we|maybe|perhaps|i wonder|how (?:do|can|should)|why )\b/i;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function safeText(s: string): string {
  return normalize(s).replace(email, '[email]').replace(phone, '[phone]').slice(0, 300);
}
function targetFor(s: string): KeyCandidate['target'] {
  if (/\b(?:footer|snapshot|checkpoint|hash|receipt|diff|manifest|provenance|continuity)\b/i.test(s))
    return 'footer';
  if (/\b(?:todo|note|task|career|work|domain|life|body|knowledge|plan)\b/i.test(s) &&
      !/\b(?:nestnyx|backend|code|cli|api|test|deploy)\b/i.test(s))
    return 'body';
  return 'head';
}
export function extractKeySignals(messages: KeyChatMessage[]): {
  schema: 'nyx.key.chat-extraction.v1';
  status: 'PROPOSAL_ONLY';
  candidates: KeyChatSignal[];
  suppliedMessageCount: number;
  ignored: number;
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
  // Reject the whole input if it contains a credential; never serialize raw
  // input into a receipt, model response, log, or persistence layer.
  if (messages.some(m => unsafe.test(m.text))) throw Error('KEY_CHAT_UNSAFE_INPUT');
  const out: KeyChatSignal[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  messages.forEach((message,index) => {
    if (message.role !== 'user') { ignored++; return; }
    const segments = message.text.split(/\n|(?<=[.!?])\s+(?=[A-Z])/).map(normalize)
      .filter(Boolean).slice(0, 24);
    for (const segment of segments) {
      const line = segment.replace(/^[-*\d.)\s]+/,'').trim();
      if (!line || line.length < 12 || speculative.test(line) ||
          (!action.test(line) && !decision.test(line))) { ignored++; continue; }
      const description = safeText(line);
      if (description.length < 12) { ignored++; continue; }
      const target = targetFor(description);
      const fingerprint = createHash('sha256').update(target + ':' +
        description.toLowerCase().replace(/[^a-z0-9]+/g,' ')).digest('hex').slice(0,16);
      if (seen.has(fingerprint)) { ignored++; continue; }
      seen.add(fingerprint);
      const explicit = /\b(?:implement|fix|repair|deploy|create|build|update|verify|enable|disable|reconcile|migrate|preserve|prevent|remove|extract)\b/i.test(line);
      const confidence = explicit ? 0.92 : action.test(line) ? 0.85 : 0.65;
      out.push({
        id:'chat_' + fingerprint, target, description,
        confidence, blocked:confidence < 0.8,
        source:'chat:user:' + (message.id || String(index + 1)),
        evidence:{message:message.id || String(index + 1),excerpt:description},
      });
    }
  });
  out.sort((a,b)=>b.confidence-a.confidence || a.id.localeCompare(b.id));
  return {schema:'nyx.key.chat-extraction.v1',status:'PROPOSAL_ONLY',
    candidates:out.slice(0,40),suppliedMessageCount:messages.length,
    ignored,textAccess:'explicit-supplied-only'};
}
