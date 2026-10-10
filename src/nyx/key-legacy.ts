import { KeyCandidate } from './key-engine';

/** Parse legacy plain-text KEY without discarding its provenance or surrounding sections. */
export function parseLegacyKey(text: string): { items: KeyCandidate[]; raw: string } {
  const section = text.match(/(?:^|\n)Prioritized active keys\s*\n([\s\S]*?)(?=\n\s*\n|$)/i);
  if (!section) throw new Error('KEY_LEGACY_SECTION_MISSING');
  const items: KeyCandidate[] = [];
  for (const line of section[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\.\s*\[(HIGH|MEDIUM|LOW)\]\s*(.+?)\s*$/i);
    if (!match) throw new Error('KEY_LEGACY_ITEM_INVALID');
    const rank = Number(match[1]);
    const confidence = match[2].toUpperCase() === 'HIGH' ? 0.9 : match[2].toUpperCase() === 'MEDIUM' ? 0.6 : 0.3;
    items.push({ id: 'legacy_' + rank, target: 'footer', description: match[3], confidence, source: 'legacy-active-key', blocked: true });
  }
  if (!items.length) throw new Error('KEY_LEGACY_EMPTY');
  return { items, raw: text };
}
/** Append a distinct proposal section; never reinterpret legacy items as ready-to-merge seeds. */
export function appendLegacyProposals(raw: string, proposals: KeyCandidate[], transactionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(transactionId)) throw new Error('KEY_TRANSACTION_INVALID');
  const lines = proposals.map(item => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || !['head','body','footer'].includes(item.target) || !item.description || /[\r\n]/.test(item.description)) throw new Error('KEY_CANDIDATE_INVALID');
    return '- [' + item.target.toUpperCase() + '] ' + item.id + ': ' + item.description + ' (source: ' + item.source + ')';
  });
  return raw.replace(/\s*$/, '') + '\n\nPending KEY proposals — ' + transactionId + '\n' + lines.join('\n') + '\n';
}
