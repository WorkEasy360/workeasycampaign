import {
  campaignAnalyticsQuery,
  campaignAnalyticsSchema,
  campaignResultsSchema,
  applyTemplateRequest,
  createTemplateRequest,
  restoreTemplateRequest,
  createSenderIdentityRequest,
  createSendingDomainRequest,
  senderIdentitySchema,
  sendingDomainSchema,
  updateSenderIdentityRequest,
  campaignTestSendRequest,
  executionSendingRateRequest,
  campaignTestSendSchema,
  campaignAudienceSampleSchema,
  createSnippetRequest,
  snippetListItemSchema,
  snippetListQuery,
  snippetViewSchema,
  updateSnippetRequest,
  templateCategoriesSchema,
  templateListItemSchema,
  templateVersionListItemSchema,
  templateVersionListQuery,
  templateVersionViewSchema,
  templateListQuery,
  templateViewSchema,
  updateTemplateRequest,
  campaignCapabilitiesSchema,
  campaignCommandRequest,
  campaignCountsByStatusSchema,
  campaignHistoryQuery,
  campaignListItemSchema,
  campaignListQuery,
  campaignVersionedCommandRequest,
  campaignViewSchema,
  cloneCampaignRequest,
  createCampaignRequest,
  executionSummarySchema,
  pageOf,
  preflightResultSchema,
  campaignPreviewRequest,
  campaignPreviewSchema,
  recipientListItemSchema,
  recipientListQuery,
  rescheduleCampaignRequest,
  scheduleCampaignRequest,
  updateCampaignRequest,
  versionDetailSchema,
  versionSummarySchema,
} from '@workeasy/shared';
import { z } from 'zod';
import type { RouteDoc } from './route-doc.js';

/** Campaign API v1 (docs/contracts/phase-6-campaign.md §15). Response schemas are generated from the shared contracts. */
const W = '/v1/workspaces/{workspaceId}/campaigns';
const r = (d: RouteDoc) => d;
const ws = (permission: string) => `workspace:${permission}`;
const out = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;

const VIEW = out(campaignViewSchema);
const VERSION_CONFLICT = 'version_conflict: the campaign changed since it was read; reload and retry';

export const CAMPAIGN_ROUTES: RouteDoc[] = [
  r({ method: 'GET', path: `${W}/capabilities`, tag: 'Campaigns', summary: 'Delivery mode and channel availability (enforced server-side)', access: ws('campaigns.read'), success: 200, response: out(campaignCapabilitiesSchema) }),
  r({ method: 'GET', path: W, tag: 'Campaigns', summary: 'List campaigns (keyset pagination, newest change first)', access: ws('campaigns.read'), query: campaignListQuery, success: 200, response: out(pageOf(campaignListItemSchema)) }),
  r({
    method: 'GET', path: `${W}/analytics`, tag: 'Campaigns',
    summary: 'Campaign analytics: measured pipeline metrics of completed runs in a UTC period (default 30 days, max 366), with delivery outcomes and engagement from rollups (Phase 7.10) where this deployment measures them; otherwise each metric states why (never a fabricated zero). Aggregates only',
    access: ws('reports.read'), query: campaignAnalyticsQuery, success: 200, response: out(campaignAnalyticsSchema), errors: { 400: 'invalid period (from ≥ to, or more than 366 days after defaults)', 429: 'rate limited: 300 per user per hour' },
  }),
  r({
    method: 'GET', path: `${W}/{campaignId}/results`, tag: 'Campaigns',
    summary: 'One campaign\x27s results (Phase 7.10): pipeline and delivery/engagement metrics of all completed runs, and the latest 10 runs one by one. Read from rollups; each metric is a value or a reason (tracking_not_enabled, delivery_not_enabled, provider_unsupported, not_applicable) — never a fabricated zero. Aggregates only',
    access: ws('reports.read'), success: 200, response: out(campaignResultsSchema), errors: { 404: 'campaign not found', 429: 'rate limited: 300 per user per hour (shared with analytics)' },
  }),
  r({ method: 'GET', path: `${W}/counts`, tag: 'Campaigns', summary: 'Campaigns per status (deleted excluded)', access: ws('campaigns.read'), success: 200, response: out(campaignCountsByStatusSchema) }),
  r({
    method: 'POST', path: W, tag: 'Campaigns', summary: 'Create a draft campaign (+ topics.read when topicId is set)', access: ws('campaigns.create'),
    body: createCampaignRequest, success: 201, idempotent: true, response: VIEW,
    errors: { 422: 'CHANNEL_NOT_AVAILABLE: sms and whatsapp are not available in Phase 6' },
  }),
  r({ method: 'GET', path: `${W}/{campaignId}`, tag: 'Campaigns', summary: 'Campaign view with readiness and allowed actions', access: ws('campaigns.read'), success: 200, response: VIEW }),
  r({
    method: 'PATCH', path: `${W}/{campaignId}`, tag: 'Campaigns', summary: 'Edit the draft (+ lists.read / tags.read / topics.read for added sources or topic)', access: ws('campaigns.update'),
    body: updateCampaignRequest, success: 200, response: VIEW,
    errors: { 409: VERSION_CONFLICT, 422: 'CAMPAIGN_NOT_EDITABLE: unschedule to edit' },
  }),
  r({
    method: 'DELETE', path: `${W}/{campaignId}`, tag: 'Campaigns', summary: 'Soft-delete (restorable; no purge)', access: ws('campaigns.delete'),
    body: campaignVersionedCommandRequest, success: 200, response: VIEW,
    errors: { 409: VERSION_CONFLICT, 422: 'CAMPAIGN_ACTIVE: cancel or unschedule first' },
  }),
  r({ method: 'POST', path: `${W}/{campaignId}/restore`, tag: 'Campaigns', summary: 'Restore a deleted campaign', access: ws('campaigns.delete'), body: campaignCommandRequest, success: 200, response: VIEW }),
  r({
    method: 'POST', path: `${W}/{campaignId}/clone`, tag: 'Campaigns', summary: 'Copy the draft (or a version snapshot) into a new draft campaign', access: ws('campaigns.create'),
    body: cloneCampaignRequest, success: 201, idempotent: true, response: VIEW,
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/preflight`, tag: 'Campaigns', summary: 'Pre-flight: readiness + topic/source status, exact audience size, eligibility estimate on a uniform sample (read-only; counts and shares only, never contact data)', access: ws('campaigns.read'),
    body: campaignCommandRequest, success: 200, response: out(preflightResultSchema), errors: { 429: 'rate limited: 60 pre-flights per user per hour' },
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/preview`, tag: 'Campaigns',
    summary: 'Render the current draft as the recipient would see it: with the example profile, or with one contact (needs contacts.read too). Read-only; the HTML is generated from structured content and must be shown in a sandboxed frame',
    access: ws('campaigns.read'), body: campaignPreviewRequest, success: 200, response: out(campaignPreviewSchema),
    errors: { 403: 'contactId given without contacts.read', 404: 'campaign or contact not found (other workspace, deleted or erased contacts are not found)', 422: 'no email message to preview', 429: 'rate limited: 600 previews per user per hour' },
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/schedule`, tag: 'Campaigns', summary: 'Schedule (mode "at") or send now (mode "now"): pre-flight, then an immutable version and a pending execution (not processed in Phase 6.8)', access: ws('campaigns.send'),
    body: scheduleCampaignRequest, success: 200, idempotent: true, response: VIEW,
    errors: { 409: VERSION_CONFLICT + ' | INVALID_TRANSITION | PREFLIGHT_UNAVAILABLE (audience being prepared; Retry-After; nothing written)', 422: 'PREFLIGHT_FAILED (with findings) | DELIVERY_NOT_AVAILABLE' },
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/reschedule`, tag: 'Campaigns', summary: 'Move the pending send time (schedule checks re-run)', access: ws('campaigns.send'),
    body: rescheduleCampaignRequest, success: 200, idempotent: true, response: VIEW,
    errors: { 409: VERSION_CONFLICT + ' | INVALID_TRANSITION', 422: 'PREFLIGHT_FAILED' },
  }),
  r({ method: 'POST', path: `${W}/{campaignId}/unschedule`, tag: 'Campaigns', summary: 'Cancel the pending execution and return to draft (no-op if draft)', access: ws('campaigns.send'), body: campaignVersionedCommandRequest, success: 200, idempotent: true, response: VIEW, errors: { 409: VERSION_CONFLICT } }),
  r({ method: 'POST', path: `${W}/{campaignId}/pause`, tag: 'Campaigns', summary: 'Pause a sending campaign (no-op if paused)', access: ws('campaigns.send'), body: campaignCommandRequest, success: 200, idempotent: true, response: VIEW, errors: { 409: 'INVALID_TRANSITION' } }),
  r({ method: 'POST', path: `${W}/{campaignId}/resume`, tag: 'Campaigns', summary: 'Resume a paused campaign after the start-time re-check (no-op if sending)', access: ws('campaigns.send'), body: campaignCommandRequest, success: 200, idempotent: true, response: VIEW, errors: { 409: 'INVALID_TRANSITION', 422: 'DELIVERY_NOT_AVAILABLE' } }),
  r({ method: 'POST', path: `${W}/{campaignId}/cancel`, tag: 'Campaigns', summary: 'Cancel a scheduled, sending or paused campaign (terminal; no-op if cancelled)', access: ws('campaigns.send'), body: campaignVersionedCommandRequest, success: 200, idempotent: true, response: VIEW, errors: { 409: VERSION_CONFLICT } }),
  r({ method: 'POST', path: `${W}/{campaignId}/return-to-draft`, tag: 'Campaigns', summary: 'Return a failed campaign to draft (no-op if draft)', access: ws('campaigns.update'), body: campaignCommandRequest, success: 200, response: VIEW, errors: { 409: 'INVALID_TRANSITION' } }),
  r({
    method: 'POST', path: `${W}/{campaignId}/versions/{versionId}/restore`, tag: 'Campaigns', summary: 'Copy a version snapshot into the draft (an edit: same rules and permissions as PATCH)', access: ws('campaigns.update'),
    body: campaignVersionedCommandRequest, success: 200, response: VIEW,
    errors: { 409: VERSION_CONFLICT, 422: 'CAMPAIGN_NOT_EDITABLE: unschedule to edit' },
  }),
  r({ method: 'GET', path: `${W}/{campaignId}/executions`, tag: 'Campaigns', summary: 'Executions of the campaign, newest run first (counts, health, failure; no recipient data)', access: ws('campaigns.read'), query: campaignHistoryQuery, success: 200, response: out(pageOf(executionSummarySchema)) }),
  r({
    method: 'PUT', path: `${W}/{campaignId}/executions/{executionId}/sending-rate`, tag: 'Campaigns', summary: 'Set or clear a run\x27s sending limit (hand-offs per hour, 1–1,000,000; null = none) while it is pending, materializing, delivering or paused. Applies from the next batch, together with the provider and workspace limits. Audited', access: ws('campaigns.send'),
    body: executionSendingRateRequest, success: 200, response: out(executionSummarySchema), errors: { 404: 'campaign or run not found', 422: 'the run has finished', 429: 'rate limited: 120 per user per hour' },
  }),
  r({ method: 'GET', path: `${W}/{campaignId}/executions/{executionId}`, tag: 'Campaigns', summary: 'One execution of the campaign', access: ws('campaigns.read'), success: 200, response: out(executionSummarySchema) }),
  r({
    method: 'GET', path: `${W}/{campaignId}/executions/{executionId}/recipients`, tag: 'Campaigns',
    summary: 'Recipients of one execution: status, reason codes and the contact display name (never an address); + contacts.read',
    access: ws('campaigns.read'), query: recipientListQuery, success: 200, response: out(pageOf(recipientListItemSchema)),
    errors: { 400: 'invalid query or cursor', 403: 'contacts.read missing', 404: 'campaign or execution not found', 429: 'rate limited: 1,200 pages per user per hour' },
  }),
  r({ method: 'GET', path: `${W}/{campaignId}/versions`, tag: 'Campaigns', summary: 'Committed versions, newest first', access: ws('campaigns.read'), query: campaignHistoryQuery, success: 200, response: out(pageOf(versionSummarySchema)) }),
  r({ method: 'GET', path: `${W}/{campaignId}/versions/{versionId}`, tag: 'Campaigns', summary: 'One version with its immutable snapshot', access: ws('campaigns.read'), success: 200, response: out(versionDetailSchema) }),
];

/** Email templates (docs/contracts/phase-6-content-amendment.md §6). */
const WS = '/v1/workspaces/{workspaceId}';
const TEMPLATE = out(templateViewSchema);
/** Public unsubscribe (Phase 7.8; campaign amendment §U): authorized only by the signed token in the path. */
export const UNSUBSCRIBE_ROUTES: RouteDoc[] = [
  r({ method: 'GET', path: '/v1/unsubscribe/{token}', tag: 'Unsubscribe', summary: 'What an unsubscribe link is for (organization and workspace names; whether the campaign has a topic). Changes nothing', access: 'token', success: 200, errors: { 404: 'invalid link', 429: 'rate limited: 300 per IP per hour' } }),
  r({
    method: 'POST', path: '/v1/unsubscribe/{token}', tag: 'Unsubscribe', summary: 'Unsubscribe: JSON { scope: topic | all } from the confirmation page, or the RFC 8058 one-click form body List-Unsubscribe=One-Click (topic). Idempotent; recorded by Audience with actor contact', access: 'token',
    success: 200, errors: { 400: 'unknown body', 404: 'invalid link', 429: 'rate limited: 120 per IP per hour' },
  }),
];

/** Provider webhooks (Phase 7.9; delivery-providers.md §6; messaging amendment §4): authorized only by the provider signature over the raw body. */
export const WEBHOOK_ROUTES: RouteDoc[] = [
  r({
    method: 'GET', path: '/v1/webhooks/{provider}', tag: 'Webhooks', summary: 'Meta webhook subscription handshake (WhatsApp): returns hub.challenge as text when hub.mode=subscribe and hub.verify_token matches WHATSAPP_VERIFY_TOKEN', access: 'token',
    success: 200, errors: { 403: 'verify token mismatch', 404: 'not WhatsApp, or WhatsApp not configured', 429: 'rate limited: 60 per IP per minute' },
  }),
  r({
    method: 'POST', path: '/v1/webhooks/{provider}', tag: 'Webhooks', summary: 'Delivery feedback from a configured provider: mailgun (email: delivered, deferred, hard bounce, complaint, unsubscribe, open, click), twilio (SMS status callbacks: delivered, failed; and replies to the SMS number: STOP withdraws the SMS consent of the contact where the number was texted, START undoes only that — answered with empty TwiML), whatsapp (Meta statuses: delivered, read, failed; failure 131050 withdraws the WhatsApp consent of the contact). Signature verified over the raw body; each signature token accepted once per body; tenant resolved from the provider message id; events deduplicated by provider event id. Responds with counts only', access: 'token',
    success: 200, errors: { 400: 'not JSON', 401: 'signature invalid, stale, or replayed with another body', 404: 'no such provider, or webhooks not configured', 413: 'body over 256 KiB', 429: 'rate limited: 30000 per IP per minute' },
  }),
];

/** Sending domains and sender identities (Phase 7.8b; campaign amendment §S). */
export const SENDER_ROUTES: RouteDoc[] = [
  r({ method: 'GET', path: `${WS}/sending-domains`, tag: 'Deliverability', summary: 'Sending domains with their last DNS checks and the records to publish', access: ws('campaigns.read'), success: 200, response: out(z.strictObject({ data: z.array(sendingDomainSchema) })) }),
  r({ method: 'POST', path: `${WS}/sending-domains`, tag: 'Deliverability', summary: 'Add a sending domain (pending until verified by DNS)', access: ws('deliverability.manage'), body: createSendingDomainRequest, success: 201, response: out(sendingDomainSchema), errors: { 400: 'not a public domain', 409: 'already added', 429: 'rate limited: 200 writes per user per hour' } }),
  r({ method: 'POST', path: `${WS}/sending-domains/{domainId}/verify`, tag: 'Deliverability', summary: 'Check ownership, SPF, DKIM and DMARC in DNS now; verified only if all pass (a DNS outage never downgrades)', access: ws('deliverability.manage'), success: 200, response: out(sendingDomainSchema), errors: { 404: 'not found', 429: 'rate limited: 60 checks per user per hour' } }),
  r({ method: 'DELETE', path: `${WS}/sending-domains/{domainId}`, tag: 'Deliverability', summary: 'Remove a domain (soft); refused while identities use it', access: ws('deliverability.manage'), success: 204, errors: { 422: 'identities still use it' } }),
  r({ method: 'GET', path: `${WS}/sender-identities`, tag: 'Deliverability', summary: 'Sender identities (verified = their domain is verified)', access: ws('campaigns.read'), success: 200, response: out(z.strictObject({ data: z.array(senderIdentitySchema) })) }),
  r({ method: 'POST', path: `${WS}/sender-identities`, tag: 'Deliverability', summary: 'Add a sender address on a sending domain', access: ws('deliverability.manage'), body: createSenderIdentityRequest, success: 201, response: out(senderIdentitySchema), errors: { 404: 'domain not found', 409: 'address exists' } }),
  r({ method: 'PATCH', path: `${WS}/sender-identities/{identityId}`, tag: 'Deliverability', summary: 'Rename or change the reply-to (optimistic lock)', access: ws('deliverability.manage'), body: updateSenderIdentityRequest, success: 200, response: out(senderIdentitySchema), errors: { 409: VERSION_CONFLICT } }),
  r({ method: 'DELETE', path: `${WS}/sender-identities/{identityId}`, tag: 'Deliverability', summary: 'Remove a sender identity (soft); campaigns using it get SENDER_NOT_VERIFIED', access: ws('deliverability.manage'), success: 204 }),
];

export const TEMPLATE_ROUTES: RouteDoc[] = [
  r({ method: 'GET', path: `${WS}/templates`, tag: 'Templates', summary: 'List templates (keyset pagination, most recently updated first; no content)', access: ws('templates.read'), query: templateListQuery, success: 200, response: out(pageOf(templateListItemSchema)) }),
  r({
    method: 'POST', path: `${WS}/templates`, tag: 'Templates', summary: 'Create a template from email.content.v2, save a campaign draft as a template (fromCampaignId; + campaigns.read), or clone a template (fromTemplateId)', access: ws('templates.manage'),
    body: createTemplateRequest, success: 201, response: TEMPLATE, errors: { 409: 'conflict: a live template with this name exists', 422: 'content incomplete (one field error per problem), or the campaign draft is not block content', 429: 'rate limited: 600 template writes per user per hour' },
  }),
  r({ method: 'GET', path: `${WS}/templates/{templateId}`, tag: 'Templates', summary: 'Get a template with its content', access: ws('templates.read'), success: 200, response: TEMPLATE }),
  r({
    method: 'PATCH', path: `${WS}/templates/{templateId}`, tag: 'Templates', summary: 'Update name, description or content (optimistic lock)', access: ws('templates.manage'),
    body: updateTemplateRequest, success: 200, response: TEMPLATE, errors: { 409: 'version_conflict, or the name is taken', 422: 'content incomplete', 429: 'rate limited: 600 template writes per user per hour' },
  }),
  r({ method: 'DELETE', path: `${WS}/templates/{templateId}`, tag: 'Templates', summary: 'Soft-delete a template (campaigns that used it keep their copy)', access: ws('templates.manage'), success: 204, errors: { 429: 'rate limited: 600 template writes per user per hour' } }),
  r({
    method: 'GET', path: `${W}/{campaignId}/audience-sample`, tag: 'Campaigns', summary: 'A uniform sample (≤ 5) of the live audience with current eligibility — display names and reason codes only (+ contacts.read)', access: ws('campaigns.read'),
    success: 200, response: out(campaignAudienceSampleSchema), errors: { 403: 'missing contacts.read', 404: 'campaign not found', 429: 'rate limited: 300 per user per hour' },
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/test-send`, tag: 'Campaigns', summary: "Send the current draft to the requesting user's own verified address (example profile, or one contact with contacts.read); never to an address from the request", access: ws('campaigns.update'),
    body: campaignTestSendRequest, success: 200, response: out(campaignTestSendSchema),
    errors: { 403: 'missing contacts.read (with contactId)', 404: 'campaign or contact not found', 422: 'DELIVERY_NOT_AVAILABLE; the message has content errors (fields by pointer); email_not_verified', 429: 'rate limited: 20 test sends per user per hour', 503: 'TEST_SEND_FAILED: the provider did not accept it (Retry-After)' },
  }),
  r({ method: 'GET', path: `${WS}/snippets`, tag: 'Templates', summary: 'List saved blocks (keyset pagination, most recently updated first; no blocks)', access: ws('templates.read'), query: snippetListQuery, success: 200, response: out(pageOf(snippetListItemSchema)) }),
  r({
    method: 'POST', path: `${WS}/snippets`, tag: 'Templates', summary: 'Save reusable blocks (email.content.v3 blocks, ≤ 20; validated with the v3 content rules, stored canonical)', access: ws('templates.manage'),
    body: createSnippetRequest, success: 201, response: out(snippetViewSchema), errors: { 409: 'conflict: a live saved block with this name exists', 422: 'blocks invalid (one field error per problem, keyed blocks/…)', 429: 'rate limited: 600 template writes per user per hour' },
  }),
  r({ method: 'GET', path: `${WS}/snippets/{snippetId}`, tag: 'Templates', summary: 'Get a saved block with its blocks', access: ws('templates.read'), success: 200, response: out(snippetViewSchema) }),
  r({
    method: 'PATCH', path: `${WS}/snippets/{snippetId}`, tag: 'Templates', summary: 'Rename or replace the blocks (optimistic lock)', access: ws('templates.manage'),
    body: updateSnippetRequest, success: 200, response: out(snippetViewSchema), errors: { 409: 'version_conflict, or the name is taken', 422: 'blocks invalid', 429: 'rate limited: 600 template writes per user per hour' },
  }),
  r({ method: 'DELETE', path: `${WS}/snippets/{snippetId}`, tag: 'Templates', summary: 'Soft-delete a saved block (messages that inserted it keep their copy)', access: ws('templates.manage'), success: 204, errors: { 429: 'rate limited: 600 template writes per user per hour' } }),
  r({ method: 'GET', path: `${WS}/template-categories`, tag: 'Templates', summary: 'Distinct categories of live templates (case-insensitively distinct)', access: ws('templates.read'), success: 200, response: out(templateCategoriesSchema) }),
  r({
    method: 'GET', path: `${WS}/templates/{templateId}/versions`, tag: 'Templates', summary: 'Version history of a live template, newest first (immutable; keyset pagination)', access: ws('templates.read'),
    query: templateVersionListQuery, success: 200, response: out(pageOf(templateVersionListItemSchema)), errors: { 404: 'template not found or deleted' },
  }),
  r({ method: 'GET', path: `${WS}/templates/{templateId}/versions/{version}`, tag: 'Templates', summary: 'One recorded version with its content', access: ws('templates.read'), success: 200, response: out(templateVersionViewSchema), errors: { 404: 'template or version not found' } }),
  r({
    method: 'POST', path: `${WS}/templates/{templateId}/restore`, tag: 'Templates', summary: 'Restore an older version as a NEW version (description, category, content; the name is kept). Restoring the current state changes nothing', access: ws('templates.manage'),
    body: restoreTemplateRequest, success: 200, response: TEMPLATE, errors: { 404: 'template or version not found', 409: VERSION_CONFLICT, 429: 'rate limited: 600 template writes per user per hour' },
  }),
  r({
    method: 'POST', path: `${W}/{campaignId}/apply-template`, tag: 'Campaigns', summary: "Copy a template's content into the draft's message (+ templates.read; same rules as a draft edit)", access: ws('campaigns.update'),
    body: applyTemplateRequest, success: 200, response: VIEW, errors: { 403: 'missing templates.read', 404: 'campaign or template not found', 409: VERSION_CONFLICT, 422: 'CAMPAIGN_NOT_EDITABLE: the campaign is not a draft' },
  }),
];
