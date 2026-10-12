import { createDatabase, type Database } from '@workeasy/db';
import type { AppConfig } from '../config/env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DATABASE = Symbol('DATABASE');

export function databaseFactory(config: AppConfig): Database {
  return createDatabase({ url: config.databaseUrl, maxConnections: 10, applicationName: 'workeasy-api' });
}

/**
 * Audience read-side port (`EligibilityEvaluator<Tx>` from @workeasy/audience-core). Bound by the Audience module — the
 * composition root that owns @workeasy/audience-infra — so consumers inject the port, never the adapters.
 */
export const ELIGIBILITY_EVALUATOR = Symbol('ELIGIBILITY_EVALUATOR');

/**
 * Audience Resolution v1.1 port (`AudienceResolutionV1_1<Tx>` from @workeasy/audience-core: v1 + sample + topicStatus).
 * Bound by the Audience module (composition root); Campaigns inject the port, never the adapter.
 */
export const AUDIENCE_RESOLUTION = Symbol('AUDIENCE_RESOLUTION');
/** Audience Resolution recovery (v1.2): Audience-owned, bound by the Audience module. */
export const AUDIENCE_RECOVERY = Symbol('AUDIENCE_RECOVERY');
/** Audience Profiles v1 (`AudienceProfiles<Tx>`): merge data and display names. Bound by the Audience module. */
export const AUDIENCE_PROFILES = Symbol('AUDIENCE_PROFILES');
/** Audience consent writes on behalf of a contact (Phase 7.8): the ConsentRecorder port. */
export const CONSENT_RECORDER = Symbol('CONSENT_RECORDER');
/** Audience Address Lookup port (E-4): send-to values for delivery (Phase 7.7). */
export const ADDRESS_LOOKUP = Symbol('ADDRESS_LOOKUP');
/** The email provider adapter (ChannelAdapter) used by the provider delivery port; null when none is configured. */
export const DELIVERY_ADAPTER = Symbol('DELIVERY_ADAPTER');
/** Audience DeliverySuppressions port (Phase 7.9): hard bounces and complaints suppress the address. */
export const DELIVERY_SUPPRESSIONS = Symbol('DELIVERY_SUPPRESSIONS');
/** SMS and WhatsApp provider adapters (messaging amendment); null when the channel is not configured. */
export const SMS_ADAPTER = Symbol('SMS_ADAPTER');
export const WHATSAPP_ADAPTER = Symbol('WHATSAPP_ADAPTER');
/** Audience AudienceUsage port (Phase 7.13): contacts.active and storage.bytes gauges. */
export const AUDIENCE_USAGE = Symbol('AUDIENCE_USAGE');
