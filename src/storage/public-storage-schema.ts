export const PUBLIC_STORAGE_SCHEMA = {
  google_main: { provider: 'drive', access: 'read' },
  google_work: { provider: 'drive', access: 'write' },
  google_a: { provider: 'drive', access: 'write' },
  google_b: { provider: 'drive', access: 'write' },
  google_c: { provider: 'drive', access: 'write' },
  google_d: { provider: 'drive', access: 'write' },
  mega_main: { provider: 'mega', access: 'read' },
  mega_work: { provider: 'mega', access: 'write' },
} as const;

export type PublicStorageSlot = keyof typeof PUBLIC_STORAGE_SCHEMA;
export function resolvePublicStorageSlot(slot: string) {
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_STORAGE_SCHEMA, slot)) {
    throw new Error('Unsupported storage slot');
  }
  return PUBLIC_STORAGE_SCHEMA[slot as PublicStorageSlot];
}
