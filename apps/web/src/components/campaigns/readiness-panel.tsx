"use client";

import { useMutation } from "@tanstack/react-query";
import {
  type CampaignView,
  FINDING_SECTIONS,
  type PreflightResult,
  type ReadinessFinding,
} from "@workeasy/shared";
import {
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, Button, Card } from "@/components/ui";
import { ApiError, http } from "@/lib/api";
import { useWorkspaceApi } from "@/lib/audience";
import { reasonLabel, SECTION_LABEL } from "@/lib/campaigns";
import { cx, relativeTime } from "@/lib/format";
import { errorMessage } from "@/lib/forms";
import { contentFieldId } from "@/lib/content";
import { FIELD_ID } from "./draft-editor";

const UNAVAILABLE = "ELIGIBILITY_ESTIMATE_UNAVAILABLE";

/** Findings grouped by section (server values), each linking to the field it is about. */
export function FindingsList({ findings }: { findings: ReadinessFinding[] }) {
  if (!findings.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CheckCircle2 className="size-4" aria-hidden /> No problems found.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {FINDING_SECTIONS.filter((s) =>
        findings.some((f) => f.section === s),
      ).map((section) => (
        <li key={section}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
            {SECTION_LABEL[section]}
          </p>
          <ul className="mt-1 space-y-1">
            {findings
              .filter((f) => f.section === section)
              .map((f, i) => {
                const target = f.field ? (FIELD_ID[f.field] ?? contentFieldId(f.field)) : undefined;
                const Icon =
                  f.severity === "error"
                    ? AlertCircle
                    : f.severity === "warning"
                      ? TriangleAlert
                      : CheckCircle2;
                return (
                  <li key={`${f.code}-${i}`} className="flex gap-2 text-sm">
                    <Icon
                      className={cx(
                        "mt-0.5 size-4 shrink-0",
                        f.severity === "error"
                          ? "text-danger"
                          : f.severity === "warning"
                            ? "text-warning"
                            : "text-ink-faint",
                      )}
                      aria-hidden
                    />
                    <span>
                      <span className="sr-only">
                        {f.severity === "error"
                          ? "Blocking: "
                          : f.severity === "warning"
                            ? "Warning: "
                            : "Note: "}
                      </span>
                      {target ? (
                        <a
                          href={`#${target}`}
                          className="underline decoration-dotted underline-offset-2 hover:text-accent"
                          onClick={(e) => {
                            const el = document.getElementById(target);
                            if (el) {
                              e.preventDefault();
                              el.focus();
                              el.scrollIntoView({ block: "center" });
                            }
                          }}
                        >
                          {f.message}
                        </a>
                      ) : (
                        f.message
                      )}
                    </span>
                  </li>
                );
              })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Pre-flight result: estimate or the honest "temporarily unavailable" state (contract §3.3) — never an invented number. */
export function EstimateView({ result }: { result: PreflightResult }) {
  const unavailable = result.readinessFindings.find(
    (f) => f.code === UNAVAILABLE,
  );
  if (unavailable) {
    return (
      <Alert
        tone="warning"
        title="Eligibility estimate temporarily unavailable"
      >
        Audience resolution recovery has been requested. The audience size and
        how many contacts can receive this campaign will be available shortly —
        try the check again in about{" "}
        {Number(unavailable.details?.retryAfterSeconds ?? 30)} seconds.
      </Alert>
    );
  }
  if (!result.estimate)
    return (
      <p className="text-sm text-ink-muted">
        Choose an audience to see its size and an eligibility estimate.
      </p>
    );
  const e = result.estimate;
  const share = e.audienceSize
    ? Math.round((e.eligibleEstimate / e.audienceSize) * 100)
    : 0;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-ink-muted">In the audience now (exact)</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {e.audienceSize.toLocaleString()}
            {e.audienceSizeCapped && "+"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Can receive it (estimate)</dt>
          <dd className="text-lg font-semibold tabular-nums">
            ≈ {e.eligibleEstimate.toLocaleString()}{" "}
            <span className="text-sm font-normal text-ink-muted">
              ({share}%)
            </span>
          </dd>
        </div>
        {e.topReasons.length > 0 && (
          <div className="col-span-2">
            <dt className="text-ink-muted">
              Main reasons contacts cannot receive it
            </dt>
            <dd>
              <ul className="mt-1 space-y-0.5">
                {e.topReasons.map((r) => (
                  <li key={r.code} className="flex justify-between gap-4">
                    <span>{reasonLabel(r.code)}</span>
                    <span className="tabular-nums text-ink-muted">
                      {Math.round(r.share * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-ink-muted">
        Estimated from a random sample of {e.sampleSize.toLocaleString()}{" "}
        contacts
        {result.checkedAt ? `, checked ${relativeTime(result.checkedAt)}` : ""}.
        The audience count is exact and live; who receives the campaign is fixed (frozen) when sending starts.
      </p>
    </div>
  );
}

export function usePreflight(campaignId: string) {
  const { path } = useWorkspaceApi();
  return useMutation({
    mutationFn: () =>
      http.post<PreflightResult>(path(`/campaigns/${campaignId}/preflight`)),
  });
}

/** Readiness rail (architecture §6): live findings from the campaign view; "Run full check" adds Audience facts. */
export function ReadinessPanel({ campaign }: { campaign: CampaignView }) {
  const preflight = usePreflight(campaign.id);
  const [checkedVersion, setCheckedVersion] = useState<number | null>(null);
  const stale = checkedVersion !== null && checkedVersion !== campaign.version;
  const result = preflight.data;
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1_000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const run = () =>
    preflight.mutate(undefined, {
      onSuccess: (r) => {
        setCheckedVersion(campaign.version);
        const u = r.readinessFindings.find((f) => f.code === UNAVAILABLE);
        setCooldown(u ? Number(u.details?.retryAfterSeconds ?? 30) : 0);
      },
    });
  const findings =
    result && !stale ? result.readinessFindings : campaign.readinessFindings;
  const errors = findings.filter((f) => f.severity === "error").length;

  return (
    <Card
      id="step-review"
      title="Review"
      description={
        result && !stale
          ? "Full check, including the audience."
          : "Quick check of this draft. Run the full check to include the audience."
      }
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={<ShieldCheck className="size-4" aria-hidden />}
          loading={preflight.isPending}
          disabled={cooldown > 0}
          onClick={run}
        >
          {cooldown > 0
            ? `Check again in ${cooldown}s`
            : result
              ? "Check again"
              : "Run full check"}
        </Button>
      }
    >
      <div className="space-y-4" aria-live="polite">
        <p
          className={cx(
            "text-sm font-medium",
            errors ? "text-danger" : "text-success",
          )}
        >
          {errors
            ? `${errors} ${errors === 1 ? "problem blocks" : "problems block"} sending`
            : "Ready to schedule"}
        </p>
        {preflight.isError && (
          <Alert tone="danger">
            {preflight.error instanceof ApiError &&
            preflight.error.status === 429
              ? "You have run many checks in the last hour. Please wait a little before checking again."
              : errorMessage(preflight.error)}
          </Alert>
        )}
        {stale && (
          <p className="text-xs text-ink-muted">
            The draft changed since the last full check.
          </p>
        )}
        {result && !stale && <EstimateView result={result} />}
        <FindingsList findings={findings} />
      </div>
    </Card>
  );
}
