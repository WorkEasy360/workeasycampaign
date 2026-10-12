import type { ProviderResult } from '@workeasy/channels';
import type { CampaignDeliveryPort, DeliveryItem, TestSendItem } from '../application/delivery.js';

/**
 * Test-only delivery (contract §9.3): performs NO I/O — no network, no SMTP, no ESP, no SMS or WhatsApp provider. It
 * acknowledges each idempotency key with a deterministic message id, and a repeat with the same key returns the same
 * acknowledgement (provider-side deduplication, contract §10.3), so a retried hand-off can never yield a second
 * acknowledgement for one recipient.
 *
 * Refuses construction unless NODE_ENV=test; wired only when CAMPAIGN_DELIVERY_MODE=test (itself accepted only with
 * NODE_ENV=test); a dependency rule allows importing it only from the campaigns module factory and tests.
 */
export class NullDeliveryPort implements CampaignDeliveryPort {
  readonly mode = 'test' as const;
  readonly idempotentSend = true;
  private readonly acks = new Map<string, { ack: string; calls: number }>();
  /** Scripted (non-acknowledged) calls per key (tests). */
  private readonly calls = new Map<string, number>();
  /** Test hook: make the next N calls fail (retryable) to exercise retries. */
  failNext = 0;
  /** Count calls per key (tests). Off for benchmarks: the acknowledgement is deterministic per key either way. */
  trackCalls = true;
  /** Test hook: called before each acknowledgement (e.g. to simulate a crash mid-delivery). */
  beforeAck: ((item: DeliveryItem) => Promise<void> | void) | null = null;

  constructor(env: { NODE_ENV?: string } = process.env) {
    if (env.NODE_ENV !== 'test') throw new Error('NullDeliveryPort is test-only (NODE_ENV=test required)');
  }

  /** Test hook (Phase 7.7 taxonomy): a scripted result for an item, or undefined for the normal acknowledgement. */
  script: ((item: DeliveryItem) => ProviderResult | undefined) | null = null;

  async deliver(item: DeliveryItem): Promise<ProviderResult> {
    const scripted = this.script?.(item);
    if (scripted) {
      this.calls.set(item.idempotencyKey, (this.calls.get(item.idempotencyKey) ?? 0) + 1);
      return scripted;
    }
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, retryable: true, code: 'NULL_TRANSIENT', message: 'simulated transient failure' };
    }
    if (this.beforeAck) await this.beforeAck(item);
    if (!this.trackCalls) return { ok: true, providerMessageId: `null:${item.idempotencyKey}` };
    const seen = this.acks.get(item.idempotencyKey);
    if (seen) {
      seen.calls++;
      return { ok: true, providerMessageId: seen.ack };
    }
    const ack = `null:${item.idempotencyKey}`;
    this.acks.set(item.idempotencyKey, { ack, calls: 1 });
    return { ok: true, providerMessageId: ack };
  }

  /** Test sends received (tests). Kept in memory only; NO I/O. */
  readonly testSends: TestSendItem[] = [];
  /** Test hook: make the next test send fail. */
  failNextTest = false;

  async sendTest(item: TestSendItem): Promise<ProviderResult> {
    if (this.failNextTest) {
      this.failNextTest = false;
      return { ok: false, retryable: true, code: 'NULL_TRANSIENT', message: 'simulated transient failure' };
    }
    this.testSends.push(item);
    return { ok: true, providerMessageId: `null-test:${item.idempotencyKey}` };
  }

  /** Distinct acknowledged keys (tests). */
  get acknowledged(): number {
    return this.acks.size;
  }
  /** Calls per key (tests): > 1 means a retried hand-off that the receiver deduplicated. */
  callsFor(key: string): number {
    return (this.acks.get(key)?.calls ?? 0) + (this.calls.get(key) ?? 0);
  }
  reset(): void {
    this.acks.clear();
    this.testSends.length = 0;
    this.failNextTest = false;
    this.failNext = 0;
    this.beforeAck = null;
    this.script = null;
    this.calls.clear();
    this.trackCalls = true;
  }
}
