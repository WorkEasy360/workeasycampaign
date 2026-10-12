import { type AddressLookup, type AudienceProfiles, type AudienceResolutionV1_2, EligibilityEvaluator } from '@workeasy/audience-core';
import { PrismaAddressLookup } from './address-lookup.js';
import { PrismaAudienceProfiles } from './audience-profiles.js';
import type { Tx } from '@workeasy/db';
import { PrismaAudienceResolution } from './audience-resolution.js';
import { PrismaEligibilityFactsReader } from './eligibility-facts-reader.js';

/**
 * @workeasy/audience-infra — the Audience context's adapters for the audience-core ports
 * (docs/contracts/phase-5-audience.md §9.8). Imported ONLY by composition roots (API Audience module, worker module),
 * which inject the ports into consumers. The Address Lookup adapter arrives with delivery (Phase 8).
 */
export { PrismaEligibilityFactsReader } from './eligibility-facts-reader.js';
export { PrismaAudienceProfiles } from './audience-profiles.js';
export { PrismaAddressLookup } from './address-lookup.js';
export {
  CAPTURE_STATEMENT_TIMEOUT,
  CAPTURE_TRANSACTION_TIMEOUT_MS,
  CaptureTransactionNotDedicatedError,
  type AudienceCountPath,
  PrismaAudienceResolution,
  type PrismaAudienceResolutionOptions,
  SNAPSHOT_CHUNK_SIZE,
  SNAPSHOT_PURGE_CHUNK,
} from './audience-resolution.js';
export {
  type CountMaintenanceLogger,
  type CountMaintenanceReport,
  type CountReconcileResult,
  type CountRebuildOptions,
  type CountRebuildOutcome,
  type CountRebuildStage,
  gcCountBitmap,
  rebuildCountBitmap,
  reconcileCountBitmap,
  runCountMaintenance,
} from './count-bitmap.js';
export { PrismaAudienceResolutionRecovery, type ResolutionRecoveryLogger } from './resolution-recovery.js';
export { discoverSnapshotCleanup, purgeUntilDone, resumeSnapshotPurges, type Workspace } from './snapshot-cleanup.js';
export { assertTenantScope, tenantScopeFor, TenantScopeMismatchError } from './tenant-scope.js';

/** The read-side services available today, bound to the database adapters. */
export interface AudienceReadSide {
  eligibility: EligibilityEvaluator<Tx>;
  /** Audience Resolution v1.2 (v1 + sample + topicStatus + bounded sampleWithin). */
  resolution: AudienceResolutionV1_2<Tx>;
  /** Audience Profiles v1 (merge data, display names). */
  profiles: AudienceProfiles<Tx>;
  /** Send-to addresses for delivery (port E-4, Phase 7.7). */
  addresses: AddressLookup<Tx>;
}

/** Wiring for a composition root (API Audience module, worker module). */
export function createAudienceReadSide(config: { fingerprintSecret: string }): AudienceReadSide {
  if (!config.fingerprintSecret) throw new Error('DATA_FINGERPRINT_SECRET is required for eligibility');
  return {
    eligibility: new EligibilityEvaluator<Tx>(new PrismaEligibilityFactsReader(), config.fingerprintSecret),
    resolution: new PrismaAudienceResolution(),
    profiles: new PrismaAudienceProfiles(),
    addresses: new PrismaAddressLookup(),
  };
}
