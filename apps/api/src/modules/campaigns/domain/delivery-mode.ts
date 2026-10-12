/**
 * Delivery capability (contract §9.3, ADR D-10). Production delivery stays disabled throughout Phase 6:
 *   disabled (default) — schedule/send/reschedule/resume are rejected with DELIVERY_NOT_AVAILABLE
 *   test               — allowed only when NODE_ENV=test; executions run against the test-only NullDeliveryPort
 *   live               — real delivery through the configured provider (2026-10-09, owner-authorized). Boot refuses it
 *                        unless the provider key, the webhook signing key and the DNS requirements are all configured
 *                        (config/env.ts); sender problems are then blocking errors (readiness `liveDelivery`).
 * Enforced on the server; the UI only explains it. OFF unless explicitly configured.
 */
export type DeliveryMode = 'disabled' | 'test' | 'live';

export class DeliveryModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryModeError';
  }
}

/** Parses CAMPAIGN_DELIVERY_MODE at boot. Throws (boot fails) on any value that would enable delivery outside tests. */
export function resolveDeliveryMode(raw: string | undefined, nodeEnv: string | undefined): DeliveryMode {
  const value = (raw ?? 'disabled').trim();
  if (value === 'disabled' || value === '') return 'disabled';
  if (value === 'test') {
    if (nodeEnv !== 'test') throw new DeliveryModeError('CAMPAIGN_DELIVERY_MODE=test is only allowed when NODE_ENV=test');
    return 'test';
  }
  if (value === 'live') return 'live';
  throw new DeliveryModeError(`Unknown CAMPAIGN_DELIVERY_MODE "${value}"`);
}

export const isDeliveryAvailable = (mode: DeliveryMode) => mode === 'test' || mode === 'live';
