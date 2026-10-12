# Delivery providers — adapters, outcome taxonomy, production port (milestone 7.7)

**Status:** implemented and tested against deterministic doubles. **Live delivery is implemented and OFF by default**
(owner-authorized 2026-10-09, §7). It is enabled only by explicit configuration, after the owner's controlled smoke test
against the real provider account. Real-account validation is environment-dependent: NOT RUN here.

This document covers email (Mailgun, SMTP). SMS (Twilio) and WhatsApp (Meta Cloud API) are described in
docs/contracts/phase-7-messaging-amendment.md.

## 1. Layers

```text
ExecutionService (claims, Checkpoint B, outcomes)        ── campaign domain, provider-agnostic
  └─ CampaignDeliveryPort                                 ── ids in, ProviderResult out
       ├─ NullDeliveryPort         (tests: no I/O)
       └─ ProviderDeliveryPort     (production shape)
            ├─ version (frozen) · sender identity (DNS-verified) · Audience ports (address, personalization)
            ├─ renderer (@workeasy/content) · unsubscribe token + RFC 8058 headers
            └─ ChannelAdapter      (packages/channels)
                 ├─ SmtpEmailAdapter
                 └─ MailgunEmailAdapter  (+ signed webhooks)
```

Provider states never cross the `ChannelAdapter` boundary; the rest of the system sees only the taxonomy below.

## 2. Outcome taxonomy

| Kind | Meaning | Recipient | Execution |
|---|---|---|---|
| accepted (`ok`) | the provider took the message (provider message id) | `sent` (final) + provider route recorded | continues |
| `transient` | failed before the provider could have accepted it (connection refused, DNS, 5xx) | `queued` again (an attempt is counted; at most 4) | continues |
| `throttled` | the provider asks us to slow down (HTTP 429 + Retry-After, SMTP 421/452) | the rest of the batch goes back to `queued` **without consuming an attempt** | the run is re-dispatched after Retry-After as a durable delayed job (not counted towards stalling) |
| `rejected` | refused for this message/recipient for good (HTTP 400, SMTP 5xx; address or contact gone) | `failed` (final) | continues |
| `configuration` | every send would fail: credentials, sending domain, unverified sender (401/403/404, SMTP 535, `SENDER_NOT_VERIFIED`) | the batch goes back to `queued` without consuming an attempt | retried with back-off; stalls with the alert `campaign_delivery_provider_configuration`; resumes once fixed — nothing lost or duplicated |
| `unknown` | the request may have reached the provider (timeout, connection reset mid-request, accepted without id) | `unknown` (final) — **never resent**, since the provider has no idempotency keys | continues |

Later outcomes (delivered, bounced hard or soft, complained, unsubscribed, opened, clicked) arrive through verified
webhooks as `message.*` events (milestone 7.9).

## 3. Adapters

| | SMTP | Mailgun (HTTP) |
|---|---|---|
| Transport | nodemailer; connect/greet 10 s, socket 30 s | `POST /v3/{domain}/messages` (multipart), basic auth, 15 s timeout; https only (loopback http allowed for tests) |
| Message id | deterministic `<idempotency key@sender domain>` | the provider's id |
| Idempotency | none at the receiver → `idempotentSend = false` | none → `idempotentSend = false` |
| Headers | passed through; CR/LF rejected | `h:` fields; names/values with CR/LF dropped (header injection) |
| Webhooks | none (bounce mailbox, later) | HMAC-SHA256 over `timestamp + token`, constant-time, 15-minute replay window, deduplicated by event id at ingestion |

## 4. Production port

Per recipient, outside any database lock and after Checkpoint B (contract §6.2):
1. Read the frozen version (cached per execution).
2. Resolve the sender identity; its domain must be DNS-verified, otherwise the result is `configuration`.
3. Get the address through the Audience Address Lookup port (port E-4, adapter added in 7.7). Gone means `rejected`.
4. Personalize through the Audience Profiles port.
5. Render, using the per-recipient unsubscribe link (`/unsubscribe/<token>`).
6. Add `List-Unsubscribe` and `List-Unsubscribe-Post`.
7. Hand off with idempotency key = recipient id.
8. On acceptance, insert `provider_message_routes(provider, provider message id → org, workspace, recipient)`.

Rendered content and addresses exist only in memory for the hand-off.

## 5. Evidence (MEASURED, 2026-10-09)

- `packages/channels` (28 tests): the Mailgun API against a local HTTP double (form, auth, every status class, refused connection, timeout, accepted without id, unsafe configuration); webhook verification (valid, wrong key, tampered, stale, future, malformed, empty key); event mapping; SMTP classification table.
- `campaigns-delivery-outcomes.test.ts` (5 tests): the engine on every kind (unknown never resent; rejected; transient retried; throttled waits without consuming attempts; configuration retried, completes once fixed without duplicates, and stalls when it persists with nothing failed).
- `provider-delivery.test.ts` (3 tests, end to end through the Mailgun adapter and a local double): nothing is handed off without a verified sender (recipients wait, none failed); personalized emails from the verified sender with Reply-To, RFC 8058 headers and a working per-recipient unsubscribe link; provider routes recorded; no address or content in the database; 429 then send; a timeout is `unknown`.

**Environment-dependent (NOT RUN):** a real Mailgun account (credentials, a verified sending domain, live webhooks), and a real SMTP relay.

## 6. Delivery feedback webhooks (milestone 7.9)

`POST /v1/webhooks/{provider}` — access policy `token` (no session, no CSRF), 30000 per IP per minute, body ≤ 256 KiB.
The endpoint exists only for the configured provider with `DELIVERY_WEBHOOK_SIGNING_KEY` set (otherwise 404).

| Step | Rule |
|---|---|
| Authenticity | adapter `verifyCallback` over the exact bytes received (kept by a `preParsing` hook), HMAC constant-time, 15-minute window |
| Replay | Mailgun signs `timestamp + token`, not the body. Each token is claimed once per body (`app.claim_webhook_token`, table `webhook_replay_tokens`: RLS forced, no grants, definer function only): same token + same body = provider retry, accepted; same token + different body = forged, 401 |
| Tenant | `provider_message_routes` via `app.resolve_provider_message` only; never the payload. Unknown message id → 200 `unrouted` (ignored) |
| Deduplication | `message_events` UNIQUE (provider, provider event id); a duplicate changes nothing |
| Audience effects | before the event is recorded, all idempotent: hard bounce → address suppression `hard_bounce`, complaint → `complaint` (port `DeliverySuppressions`, source `system`); provider unsubscribe → `ConsentRecorder`, actor contact, source `provider_unsubscribe`, topic-scoped when the campaign has a topic. A failure returns non-2xx so the provider retries; nothing is lost behind deduplication |
| Rollups | in the event's transaction, only for a new event: `recipient_engagement` firsts (earliest time wins, any arrival order; a click implies an open; a hard bounce replaces a soft one) and `execution_engagement` unique counters. The runtime role may update fact columns only (column grants) |
| Privacy | ids, types, times and short reason codes (e.g. `SMTP_550`) only — no address, URL, IP, user agent or provider text |

Soft bounces are the provider's temporary failures (`deferred`); `bounced` is always permanent.

**Opens and clicks are provider-reported** and NOT machine-filtered (Apple Mail Privacy Protection and link scanners are
included); analytics must label them so (milestone 7.10). Open/click tracking at the provider is a domain setting, not
enabled by this product.

**Evidence (MEASURED, 2026-10-09)** — `apps/api/test/delivery-webhooks.test.ts`, 6 tests, real executions through the
Mailgun adapter against a local double: unique engagement and click-implies-open; provider retry and re-signed duplicates
change nothing; out-of-order events keep the earliest times; soft → hard bounce and complaint suppress the address through
Audience (one suppression, replay-safe); provider unsubscribe recorded as the contact's own; wrong key, stale, unsigned,
non-JSON and re-bodied signatures refused with nothing recorded; unknown messages ignored; unknown provider and
unconfigured webhooks 404; another organization sees none of the rows through RLS. No address or URL stored.
`security-invariants` (7) covers the new tables (RLS forced; no key column updatable).

**Environment-dependent (NOT RUN):** live Mailgun webhooks against a public HTTPS endpoint.

## 7. Live delivery mode (owner-authorized 2026-10-09; off unless configured)

| Requirement | Enforced by |
|---|---|
| `CAMPAIGN_DELIVERY_MODE=live` set explicitly (default `disabled`) | config |
| `DELIVERY_PROVIDER=mailgun`, `MAILGUN_API_KEY` (secret), `MAILGUN_BASE_URL` (US or EU https endpoint only) | boot fails otherwise |
| `DELIVERY_WEBHOOK_SIGNING_KEY`, `DELIVERY_SPF_INCLUDE`, `DELIVERY_DKIM_SELECTOR` (feedback and domain verification) | boot fails otherwise |
| A verified sender identity on every campaign (and every test send) | readiness `liveDelivery`: `SENDER_NOT_CONFIGURED` / `SENDER_NOT_VERIFIED` are errors, so scheduling is refused (422 `PREFLIGHT_FAILED`); the port refuses again at hand-off (`configuration`) |
| The wired port matches the mode (a test port never runs under live) | `ExecutionService.deliveryAvailable` |

**Per-customer domain.** Each message is sent through `/v3/<sender's verified domain>/messages`, so every customer
sending domain must also be added to the Mailgun account (DKIM keys from Mailgun). A malformed domain is refused before
any request.

**Test sends** come from the campaign's verified sender, through its domain, to the requesting user's own verified
address.

**Metering:** `messages.sent` is recorded in the outcome transaction, once per batch.

**UI:** no test-mode banner in live mode.

**Evidence (MEASURED 2026-10-09, local provider double, no real mailbox):**
- `apps/api/test/delivery-live.test.ts` (2):
  - an unconfigured or unverified sender blocks scheduling and test sends, and nothing reaches the provider;
  - with a verified sender: 3 of 3 sent through `/v3/mail.acme.com/messages` from the verified address, `messages.sent` = 3 in one record, results report `live`.
- `packages/channels` (29): per-domain path; missing or malicious domain refused.
- `config.test.ts`: the requirements.
- Web: `campaigns.test.tsx`: no test banner in live mode.

**Enable (owner):** docs/operations/release-checklist.md §6.
