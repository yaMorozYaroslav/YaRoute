import { createHash } from 'node:crypto';
import type { KeyCandidate } from './key-engine';

/**
 * Dev-only strict adapter for the accepted but NOT YET CANONICAL Yaro
 * KEY shorthand. It never redefines the general x command separator.
 *
 * In canonical H32 these are two separately verified commands:
 *   Nyx key oF x key oS Go
 * In Dev, also accept:
 *   Nyx key oF x oS Go  /  Nyx key oFxS Go
 */
export function parseKeyFsCommand(input: string): {
  scope: 'local'|'global';
  expanded: string;
  aliasPendingHead: boolean;
} {
  if (typeof input !== 'string' || input.length < 8 || input.length > 100)
    throw Error('KEY_FS_COMMAND_INVALID');
  const compact = input.replace(/\s+/g,'');
  const match = /^nyxkey(?:ofxos|ofxkeyos|ofxs)(go)?$/i.exec(compact);
  if (!match) throw Error('KEY_FS_COMMAND_INVALID');
  const scope = match[1] ? 'global' : 'local';
  return {
    scope,
    expanded: 'NyxkeyoFxkeyoS' + (scope === 'global' ? 'Go' : ''),
    aliasPendingHead: !/^nyxkeyofxkeyos(?:go)?$/i.test(compact),
  };
}

export function keyFsFingerprint(scope:'local'|'global', candidates:KeyCandidate[]):string {
  if (!candidates.length) throw Error('KEY_NO_GROUNDED_CANDIDATES');
  const normalized=candidates.map(x=>({
    id:x.id,target:x.target,description:x.description,
    confidence:x.confidence,source:x.source,blocked:x.blocked===true,
  })).sort((a,b)=>a.id.localeCompare(b.id)||a.target.localeCompare(b.target));
  return createHash('sha256').update(JSON.stringify({scope,candidates:normalized})).digest('hex');
}

export function keyFsTransactionId(fingerprint:string, supplied?:string):string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw Error('KEY_FS_FINGERPRINT_INVALID');
  if (supplied !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,73}$/.test(supplied))
      throw Error('KEY_FS_TRANSACTION_ID_INVALID');
    return supplied;
  }
  return 'fs_' + fingerprint.slice(0,32);
}
