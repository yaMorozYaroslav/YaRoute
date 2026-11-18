import { createHash } from 'node:crypto';
import { parseJson, profileSchema } from './runtime.schema';

export const RUNTIME_PROFILE_PATH = 'config/nyx-runtime-profile.json';
export const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const gitBlobHash = (value: string) => createHash('sha1')
  .update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex');
export type ReviewedPin = { key: string; sha256: string };

/** A repository profile must not select new operator-private source paths. */
export function assertRuntimePinBoundary(configured: string, target: string) {
  const withoutPins = (text: string) => {
    const profile = profileSchema.parse(parseJson(text));
    if (!profile.keySources.length || profile.keySources.length > 32 ||
        new Set(profile.keySources.map(pin => pin.key)).size !== profile.keySources.length)
      throw new Error('MAINTENANCE_PROFILE_BOUNDARY_CHANGED');
    return {...profile, keySources: profile.keySources.map(pin => ({...pin, sha256: ''}))};
  };
  if (JSON.stringify(withoutPins(configured)) !== JSON.stringify(withoutPins(target)))
    throw new Error('MAINTENANCE_PROFILE_BOUNDARY_CHANGED');
}

/** Exact reviewed pins only. Never add sources, rewrite refs/CLI, or weaken contracts. */
export function reconcileRuntimePins(text: string, reviewed: ReviewedPin[], cliHash: string) {
  const profile = profileSchema.parse(parseJson(text));
  if (profile.cliSha256 !== cliHash) throw new Error('MAINTENANCE_CLI_AUTHORITY_CHANGED');
  if (!profile.keySources.length || profile.keySources.length > 32 ||
      !Array.isArray(reviewed) || reviewed.length !== profile.keySources.length ||
      reviewed.some(pin => !pin || typeof pin.key !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
      new Set(reviewed.map(pin => pin.key)).size !== reviewed.length ||
      new Set(profile.keySources.map(pin => pin.key)).size !== profile.keySources.length) {
    throw new Error('MAINTENANCE_REVIEWED_PINS_INVALID');
  }
  const values = new Map(reviewed.map(pin => [pin.key, pin.sha256]));
  const raw = parseJson(text) as {keySources: Array<{key: string; sha256: string}>};
  const changes: Array<{key: string; before: string; after: string}> = [];
  for (const source of raw.keySources) {
    const next = values.get(source.key);
    if (!next) throw new Error('MAINTENANCE_REVIEWED_PINS_INVALID');
    if (source.sha256 !== next) changes.push({key: source.key, before: source.sha256, after: next});
    source.sha256 = next;
  }
  return {content: changes.length ? JSON.stringify(raw, null, 2) + '\n' : text, changes};
}

/** Defence in depth at the GitHub boundary: accept only the pin-only transform. */
export function assertPinOnlyRepair(before: string, after: string) {
  const parsed = profileSchema.parse(parseJson(after));
  const result = reconcileRuntimePins(before, parsed.keySources.map(pin =>
    ({key: pin.key, sha256: pin.sha256})), parsed.cliSha256);
  if (!result.changes.length || JSON.stringify(parseJson(result.content)) !==
      JSON.stringify(parseJson(after))) throw new Error('MAINTENANCE_NON_PIN_CHANGE_FORBIDDEN');
  return result.changes;
}
