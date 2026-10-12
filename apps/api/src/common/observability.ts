import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Structured operational logs (one JSON object per line). Built from ALLOWLISTS so they can never pick up personal
 * data: no raw URL or query string (searches can contain names or e-mail addresses), no headers, no bodies, no
 * user-agent or IP; ids only. Operators correlate a request, its domain events, its audit rows and its background jobs
 * through `requestId` (= the correlation id carried into job envelopes and events).
 */
export interface AccessLogEntry {
  msg: 'http';
  requestId: string;
  method: string;
  /** The ROUTE TEMPLATE, e.g. /v1/workspaces/:workspaceId/campaigns/:campaignId — never the concrete URL. */
  route: string;
  status: number;
  durationMs: number;
  outcome: 'ok' | 'client_error' | 'server_error';
  userId?: string;
  orgId?: string;
  workspaceId?: string;
}

export function accessLogEntry(req: FastifyRequest, reply: FastifyReply): AccessLogEntry {
  const status = reply.statusCode;
  return {
    msg: 'http',
    requestId: String(req.id),
    method: req.method,
    route: req.routeOptions?.url ?? 'unmatched',
    status,
    durationMs: Math.round(reply.elapsedTime),
    outcome: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok',
    ...(req.principal?.userId ? { userId: req.principal.userId } : {}),
    ...(req.access?.orgId ? { orgId: req.access.orgId } : {}),
    ...(req.access?.workspaceId ? { workspaceId: req.access.workspaceId } : {}),
  };
}

export interface JobLogEntry {
  msg: 'job';
  job: string;
  outcome: 'ok' | 'failed';
  durationMs: number;
  correlationId?: string;
  orgId?: string;
  workspaceId?: string;
  /** Allowlisted payload ids (execution, import, campaign), when present. */
  ids?: Record<string, string>;
}

const PAYLOAD_IDS = ['executionId', 'importId', 'campaignId'] as const;
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

/** Ids from a job envelope ({ tenant, actor, correlationId, payload }); anything else is ignored. */
export function jobLogEntry(job: string, data: unknown, outcome: JobLogEntry['outcome'], durationMs: number): JobLogEntry {
  const d = (data ?? {}) as { correlationId?: unknown; tenant?: { orgId?: unknown; workspaceId?: unknown }; payload?: Record<string, unknown> };
  const ids: Record<string, string> = {};
  for (const k of PAYLOAD_IDS) if (isId(d.payload?.[k])) ids[k] = d.payload![k] as string;
  return {
    msg: 'job',
    job,
    outcome,
    durationMs: Math.round(durationMs),
    ...(typeof d.correlationId === 'string' && d.correlationId.length <= 64 ? { correlationId: d.correlationId } : {}),
    ...(isId(d.tenant?.orgId) ? { orgId: d.tenant!.orgId as string } : {}),
    ...(isId(d.tenant?.workspaceId) ? { workspaceId: d.tenant!.workspaceId as string } : {}),
    ...(Object.keys(ids).length ? { ids } : {}),
  };
}
