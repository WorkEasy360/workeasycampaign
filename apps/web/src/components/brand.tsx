/** Workeasy Campaign wordmark (original mark; no third-party branding). */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-ink">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path d="M8 11l4 11 4-8 4 8 4-11" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && (
        <span className="text-[15px] tracking-tight">
          Workeasy <span className="text-ink-muted">Campaign</span>
        </span>
      )}
    </span>
  );
}
