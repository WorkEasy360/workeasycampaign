# Messaging amendment — SMS and WhatsApp campaigns (2026-10-09)

**Status:** implemented and tested against local provider doubles. Real delivery is OFF unless a provider is configured
AND sending is enabled (`CAMPAIGN_DELIVERY_MODE=live`, which still requires the email provider settings). Real-account
validation is NOT RUN (it needs the owner's Twilio / Meta accounts).

## 1. Why each channel did not work before

Traced from the UI through the API and worker to the provider:

| Layer | Email | SMS / WhatsApp (before) |
|---|---|---|
| UI create dialog | available | listed, disabled: "not available yet" (server capability) |
| Contract | `campaign.version.v1–v3` | snapshots allowed only `channel: 'email'` with email content |
| Engine and pre-flight | eligibility per channel (Audience) | hard-coded `channel: 'email'` |
| Provider adapter | Mailgun, SMTP | none |
| Webhooks | Mailgun (signed) | none |
| Audience (consent, addresses, suppression, eligibility) | yes | **already multi-channel** |

Email "failing" locally is configuration, not code: without `CAMPAIGN_DELIVERY_MODE`, the server reports sending as
disabled, and the UI says "Sending is not available yet".

## 2. Contract

**Content** (`packages/shared/src/content-messaging.ts`):

- `sms.content.v1`: `{ text }`, at most 1,600 characters, personalized with merge_tags_v2. The renderer appends "Reply STOP to opt out." unless the text mentions STOP, and the length limit counts it.
- `whatsapp.content.v1`: `{ template: { name, language, parameters[] } }`. The template is a Meta-APPROVED template; parameters `{{1}}…{{n}}` (at most 10) are personalized with merge_tags_v2. The template text lives at Meta and is never shown as a guess.

**Snapshot `campaign.version.v4`** — SMS and WhatsApp only; email keeps writing v2/v3 unchanged:

- sender fields are all null (the provider number is deployment configuration);
- compliance: `optOut` (`sms_stop_instruction` or `whatsapp_template`);
- personalization `merge_tags_v2`;
- the content schema must match the channel.

The database CHECK is widened additively in migration `20261031000000_messaging_channels`.

**Readiness:**

- `TEMPLATE_MISSING` and `TEMPLATE_INVALID` are new codes; `BODY_MISSING` and `BODY_TOO_LONG` apply to SMS.
- `CHANNEL_NOT_AVAILABLE` now means "not configured in this deployment".
- Sender-identity rules apply to email only.

**Availability:** a channel is available when it is implemented and its provider is configured. Test delivery mode
covers every channel. `GET …/campaigns/capabilities` reports it, and the create dialog follows it ("— not configured").

## 3. Delivery

| | SMS | WhatsApp |
|---|---|---|
| Provider | Twilio Programmable Messaging (`packages/channels/src/sms/twilio.ts`) | Meta WhatsApp Business Cloud API (`packages/channels/src/whatsapp/meta.ts`) |
| Request | `POST /2010-04-01/Accounts/{SID}/Messages.json` (Basic auth), `To`, `From` or `MessagingServiceSid`, `Body`, `StatusCallback` | `POST /{version}/{phone-number-id}/messages` (Bearer), `type: template`, body parameters |
| Recipient | the contact's phone identity, **E.164** (Audience address lookup returns the normalized number) | the contact's WhatsApp identity, E.164 without "+" |
| Consent | Audience eligibility on channel `sms` | channel `whatsapp` |
| Outcome taxonomy | 401/403/404/20003 → configuration (recipients wait, none failed); 429 → throttled; 21610 (STOP), 21211/21614 → rejected; 5xx → transient; timeout → unknown (never resent) | 190/401/403 → configuration; 429/130429/131048/131056/80007/4 → throttled; 131026, 131047, 131051, 132000–132015 → rejected; 5xx → transient; timeout → unknown |
| Routing | `MessagingDeliveryPort` behind `ChannelDeliveryRouter` (only when SMS or WhatsApp is configured; otherwise the email port is wired exactly as before) | same |
| Test sends | email only (users have no verified phone) | email only |

## 4. Feedback (webhooks)

| Provider | Endpoint | Verification | Events |
|---|---|---|---|
| Twilio | `POST /v1/webhooks/twilio` | `X-Twilio-Signature`: HMAC-SHA1(auth token, `TWILIO_STATUS_CALLBACK_URL` + sorted params), constant time | `delivered` → delivered; `undelivered`/`failed` → bounced (error code kept) |
| Meta | `GET /v1/webhooks/whatsapp` (subscription: `hub.verify_token` must equal `WHATSAPP_VERIFY_TOKEN`); `POST /v1/webhooks/whatsapp` | `X-Hub-Signature-256`: HMAC-SHA256(app secret, raw body) | `delivered` → delivered; `read` → opened (read receipt); `failed` → bounced |

Both are deduplicated by event id (message id + status). The tenant comes only from `provider_message_routes`.

**SMS and WhatsApp failures never suppress the number automatically.** A failed status is often temporary (handset
off, carrier), unlike an email hard bounce.

### Opt-outs reach Audience consent

**SMS STOP / START (inbound replies).** Configure the number's (or Messaging Service's) incoming-message webhook to
the SAME URL as `TWILIO_STATUS_CALLBACK_URL` (`POST https://<api>/v1/webhooks/twilio`). Twilio signs it the same way.

- **Recognition:** a reply is a keyword when the whole message, trimmed and in any case, is one of Twilio's defaults:
  - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT → opt-out;
  - START, YES, UNSTOP → opt-in;
  - HELP, INFO → help.

  With Advanced Opt-Out, its `OptOutType` parameter decides, which covers custom keywords. The message text is never stored.
- **STOP:** the contact's SMS consent is set to *withdrawn*, recorded as the contact's own act (source `sms_stop`, evidence = the Twilio message id).
  - **Where:** every workspace whose campaign texted that number through Twilio (`app.sms_opt_out_targets`, a narrow SECURITY DEFINER lookup that returns ids only). The deployment's number is shared, and Twilio blocks it for that recipient from then on. Workspaces that never texted the number are not touched.
  - **Effect:** staff cannot override it (Audience's self-unsubscribe rule), and the next campaign skips the contact at Checkpoint A.
- **START:** sets consent back to granted ONLY where the contact's current state is a withdrawal made by an earlier STOP. A staff withdrawal or no consent at all stays as it is.
- **HELP and other replies:** change nothing; Twilio answers HELP itself.
- **Response:** the endpoint returns empty TwiML (`<Response></Response>`), so Workeasy sends no reply of its own.
- **Idempotency:** a provider retry records nothing twice.
- **Send-time refusal:** if a send is still refused with 21610 (the number opted out before this flow existed), it is *rejected*, never resent.

**WhatsApp "stopped marketing messages" (error 131050).**

- **At send time:** a refusal with 131050 is *rejected* and never resent.
- **As a `failed` status webhook:** the contact's WhatsApp consent is withdrawn (source `whatsapp_opt_out`, channel-wide, as the contact's own act). The number is not suppressed.
- **Not handled:** inbound WhatsApp messages (including quick-reply buttons) are not interpreted. Meta enforces the opt-out on its side.

**No silent fallback.** The email port refuses any SMS or WhatsApp hand-off (`CHANNEL_NOT_CONFIGURED`: recipients wait).
This covers, for example, an SMS execution that resumes after the Twilio settings were removed. Nothing is sent by
email instead.

## 5. Analytics

Per-campaign results use the channel's capabilities:

| Metric | SMS | WhatsApp |
|---|---|---|
| Delivered, bounced | counted | counted |
| Opens | `provider_unsupported` | read receipts (a lower bound: recipients can turn them off) |
| Clicks | `provider_unsupported` | `provider_unsupported` |
| Complaints, deferrals, unsubscribes | `provider_unsupported` | `provider_unsupported` |

Workspace-level engagement covers email campaigns only (rates over email sends), so SMS deliveries cannot distort email
open rates.

## 6. Evidence (MEASURED 2026-10-09, local doubles; no real provider or phone)

- `packages/channels/src/messaging-adapters.test.ts` (50): the request shapes, every outcome class (including 131050), signature verification (valid, wrong secret, tampered, wrong URL), the subscription handshake, status mapping, and inbound keyword recognition.
- `apps/api/test/messaging-channels.test.ts`, inbound opt-out cases:
  - **SMS STOP:** a forged reply is refused. A real STOP gives the contact's own withdrawal only in the workspace that texted the number; a retry records nothing twice; staff cannot re-grant; the next campaign skips the number.
  - **SMS HELP and ordinary replies:** change nothing.
  - **SMS START:** restores only a STOP withdrawal.
  - **WhatsApp 131050:** withdraws WhatsApp consent and suppresses nothing.
  - **Email port:** never carries an SMS or WhatsApp hand-off.
- `packages/db/test/rls.test.ts`: `app.sms_opt_out_targets` is SECURITY DEFINER with a pinned search_path, not executable by PUBLIC, and refuses malformed numbers.
- `packages/content/src/messaging.test.ts` (5): validation, the STOP instruction, segments, WhatsApp variables.
- `apps/api/test/messaging-channels.test.ts` (6), end to end through the real engine and the API:
  - **SMS:** only consented numbers are texted; personalized text with STOP; routes recorded; signed callbacks recorded and deduplicated, a forged one refused; no suppression on failure; analytics say "not supported".
  - **WhatsApp:** the exact Graph template request; the handshake; signed statuses with read → open; a wrong signature refused.
  - **Invalid credentials:** nothing sent or failed (recipients wait).
  - **Unconfigured channels:** unavailable and refused.
  - **Addresses:** E.164 lookup.
- `apps/api/src/config/config.test.ts`: provider settings, with partial setups refused at boot.
- Web: `messaging-editor.test.tsx` (4), and `campaign-detail.test.tsx` (SMS and WhatsApp drafts).
