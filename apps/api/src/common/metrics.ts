/**
 * Operational metrics (Phase 7.12; docs/operations/observability.md), exposed in the Prometheus text format at
 * GET /metrics (token-protected). Dependency-free and process-local: each process exposes its own; the scraper sums.
 *
 * Privacy and cardinality: label VALUES come only from fixed vocabularies (route templates, job names, outcome kinds,
 * status classes) — never ids, addresses, query strings or free text. Label values that are not in a metric's
 * allowlist are recorded as "other".
 */
type Labels = Record<string, string>;

const BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad metric name ${name}`);
  }
  abstract lines(): string[];
}

export class Counter extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0 || !Number.isFinite(by)) return;
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Histogram extends Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    private readonly buckets = BUCKETS_SECONDS,
  ) {
    super(name, help, 'histogram');
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]!++;
    s.sum += value;
    s.count++;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return out;
  }
}

/** A gauge whose values are collected at scrape time (queue depth, scheduler lag, database latency, …). */
export class Gauge extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(labels: Labels, value: number): void {
    if (Number.isFinite(value)) this.values.set(key(labels), value);
  }
  reset(): void {
    this.values.clear();
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

/** A fixed vocabulary for a label: anything else is "other" (cardinality and privacy guard). */
export function vocab<T extends string>(allowed: readonly T[]): (v: string | null | undefined) => T | 'other' {
  const set = new Set<string>(allowed);
  return (v) => (v && set.has(v) ? (v as T) : 'other');
}

class Registry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: (() => Promise<void>)[] = [];
  register<M extends Metric>(m: M): M {
    this.metrics.push(m);
    return m;
  }
  /** Runs before each scrape (gauges read from the database). A failing collector never breaks the scrape. */
  collect(fn: () => Promise<void>): void {
    this.collectors.push(fn);
  }
  clearCollectors(): void {
    this.collectors.length = 0;
  }
  async render(): Promise<string> {
    await Promise.all(this.collectors.map((c) => c().catch(() => undefined)));
    const out: string[] = [];
    for (const m of this.metrics) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.lines());
    }
    return `${out.join('\n')}\n`;
  }
}

export const registry = new Registry();

// ─── HTTP ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const httpRequests = registry.register(new Counter('workeasy_http_requests_total', 'HTTP requests by route template, method and status class'));
export const httpDuration = registry.register(new Histogram('workeasy_http_request_duration_seconds', 'HTTP request latency by route template and method'));

// ─── Jobs (durable queue and inline) ──────────────────────────────────────────────────────────────────────────────
export const jobRuns = registry.register(new Counter('workeasy_job_runs_total', 'Background job runs by job name and outcome (ok, failed)'));
export const jobDuration = registry.register(new Histogram('workeasy_job_duration_seconds', 'Background job run time by job name'));
export const jobRetries = registry.register(new Counter('workeasy_job_retries_total', 'Failed job runs that were scheduled again (not dead-lettered)'));
export const jobDeadLetters = registry.register(new Counter('workeasy_job_dead_letters_total', 'Jobs moved to the dead-letter state'));
export const jobQueueDepth = registry.register(new Gauge('workeasy_job_queue_jobs', 'Jobs in the durable queue by name and status (at scrape)'));
export const jobQueueOldestDue = registry.register(new Gauge('workeasy_job_queue_oldest_due_seconds', 'Age of the oldest due, unclaimed job by name (at scrape)'));

// ─── Campaign execution and delivery ──────────────────────────────────────────────────────────────────────────────
export const deliveryOutcomes = registry.register(new Counter('workeasy_campaign_deliveries_total', 'Hand-offs to the delivery port by outcome (sent, failed, unknown, retry, requeued)'));
export const providerFailures = registry.register(new Counter('workeasy_provider_failures_total', 'Provider failures by kind (transient, throttled, rejected, configuration, unknown)'));
export const executionRetries = registry.register(new Counter('workeasy_campaign_execution_retries_total', 'Execution runs scheduled again, by reason (infrastructure, provider_throttled, provider_configuration, send_rate)'));
export const executionStalled = registry.register(new Counter('workeasy_campaign_execution_stalled_total', 'Executions that exhausted their retries and are waiting for the recovery sweep'));
export const schedulerLag = registry.register(new Gauge('workeasy_campaign_scheduler_lag_seconds', 'Lateness of the most overdue execution started by the last scheduler tick'));
export const schedulerTicks = registry.register(new Counter('workeasy_campaign_scheduler_ticks_total', 'Scheduler ticks by outcome (ok, failed)'));

// ─── Provider feedback ──────────────────────────────────────────────────────────────────────────────────────────
export const webhookEvents = registry.register(new Counter('workeasy_webhook_events_total', 'Provider webhook events by type and result (recorded, duplicates, unrouted)'));
export const webhookRejected = registry.register(new Counter('workeasy_webhook_rejected_total', 'Provider webhooks refused, by reason (signature, replay, not_json)'));

// ─── Dependencies (at scrape) ──────────────────────────────────────────────────────────────────────────────────
export const dbPing = registry.register(new Gauge('workeasy_database_ping_seconds', 'Round trip of a trivial query to PostgreSQL (at scrape); -1 = unreachable'));
export const redisPing = registry.register(new Gauge('workeasy_redis_ping_seconds', 'Round trip to the shared rate-limit store (Redis), when configured (at scrape); -1 = unreachable'));
export const audienceCountBacklog = registry.register(new Gauge('workeasy_audience_count_maintenance_backlog', 'Workspaces whose Audience count bitmap needs rebuild or reconciliation (at scrape)'));

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;
