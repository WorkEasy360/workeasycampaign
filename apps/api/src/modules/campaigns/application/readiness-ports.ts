import type { AiAssistRequest, AiAssistResponse, UsageRecord } from '@workeasy/shared';

/**
 * Future-capability ports (docs/architecture/ai-billing-readiness.md). Bound to disabled implementations: no model is
 * called and nothing is metered in this phase. Real implementations live in their own contexts and are injected —
 * Campaigns never contains AI prompts or billing rules.
 */
export const CONTENT_ASSISTANT = Symbol('CONTENT_ASSISTANT');
export const USAGE_RECORDER = Symbol('USAGE_RECORDER');

export interface ContentAssistant {
  readonly enabled: boolean;
  /** Suggestions only — never applied automatically; applying goes through the normal draft update and validation. */
  suggest(req: AiAssistRequest, ctx: { orgId: string; workspaceId: string }): Promise<AiAssistResponse>;
}

export class DisabledContentAssistant implements ContentAssistant {
  readonly enabled = false;
  async suggest(): Promise<AiAssistResponse> {
    return { available: false, reason: 'ai_not_enabled', suggestions: [] };
  }
}

export interface UsageRecorder {
  readonly enabled: boolean;
  /** Append-only, idempotent on recordId; a failure must never fail the business operation that emitted it. */
  record(records: readonly UsageRecord[]): Promise<void>;
}

export class DisabledUsageRecorder implements UsageRecorder {
  readonly enabled = false;
  async record(): Promise<void> {}
}
