export type NyxDiagnosticSeverity =
  | 'HARD_BLOCK'
  | 'DEFERRED_WARNING'
  | 'INFORMATIONAL';

export const HEARTBIT_COREGEN_POLICY = Object.freeze({
  adaptiveKeySeedThreshold: 11,
  adaptiveKeySeedRule:
    'more than 10 decent unresolved keys after dedupe and quality filtering',
  explicitGlobalSeedCommand: 'NyxkeyoSG',
  minimumCompatibleSeedsForCoreGeneration: 1,
  deferredWarningsBlockGeneration: false,
  autoRepairDeterministicPipelineFaults: true,
  footerCompactionEveryUpdates: 6,
  forceFooterCompactionOnNextSuccessfulCoreGeneration: true,
  templateIsRecoverabilityException: true,
  coreBundleRecoverabilityRequired: true,
} as const);

export function shouldAdaptiveKeyCreateSeed(
  decentUnresolvedKeysAfterDedupe: number,
): boolean {
  return (
    decentUnresolvedKeysAfterDedupe >=
    HEARTBIT_COREGEN_POLICY.adaptiveKeySeedThreshold
  );
}

export function generationReady(
  validCompatibleUnconsumedSeeds: number,
  hardBlocks: number,
): boolean {
  return (
    validCompatibleUnconsumedSeeds >=
      HEARTBIT_COREGEN_POLICY.minimumCompatibleSeedsForCoreGeneration &&
    hardBlocks === 0
  );
}

export function diagnosticBlocksGeneration(
  severity: NyxDiagnosticSeverity,
): boolean {
  return severity === 'HARD_BLOCK';
}

export function footerCompactionDue(
  updatesSinceLastCompaction: number,
  forceNextSuccessfulCoreGeneration = false,
): boolean {
  return (
    forceNextSuccessfulCoreGeneration ||
    updatesSinceLastCompaction + 1 >=
      HEARTBIT_COREGEN_POLICY.footerCompactionEveryUpdates
  );
}
