# Progress accounting — the one authoritative figure

**Rule.** The official figure moves only when a release gate (A–H, defined in the owner's Phase 7 instruction) passes
with recorded evidence. It never moves for files, lines, partial milestones or "probably okay" gates. A gate that
fails or is re-opened gives its points back.

**History.**

| Date | Event | Official |
|---|---|---|
| (earlier) | G2 closed (owner) | 30 % → 35 % |
| 2026-10-08 | 6.7/6.8 closure + 6.9 G3 (owner-defined 10-point step; audit 6.9 §12) | 45 % |
| 2026-10-08 | Gate A — Phase 6 closed (audit 6.13 §10) | 50 % |
| 2026-10-09 | Gate B — Phase 7 core product (audit phase-7-gate-b.md) | 65 % |
| 2026-10-09 | Gate C — production infrastructure (audit phase-7-gate-c.md) | 80 % |
| 2026-10-09 | Gate D — security (audit phase-7-release-gates.md) | **85 %** |

**Allocation of the remaining points.** Fixed on 2026-10-08, *before* any Phase 7 work, so the figure cannot be fitted to
results afterwards. Proposed by engineering because the owner's instruction defines the gates but not their weights; the
owner can change the weights, and the history above then gets recomputed openly.

| Gate | Scope (owner's definition) | Points | Reason for the weight |
|---|---|---|---|
| A | Phase 6 closure (6.10–6.13) | 5 | four milestones of hardening on an engine that was already measured |
| B | Phase 7 core product: creation workflow, content, templates (history), audience UX, personalization, dynamic content, analytics UX, scheduling | 15 | the largest body of product work |
| C | Production infrastructure: durable queue, provider delivery, webhooks, tracking producers, suppression, deliverability, observability, recovery | 15 | the second largest; turns test mode into real sending |
| D | Security final audit | 5 | |
| E | Production-like scale (10k–1M, repeated) | 5 | |
| F | Accessibility (automated + manual) | 3 | |
| G | Operations: deployment, backup/restore tested, monitoring, runbooks | 5 | |
| H | Final release (all gates, final matrix) | 2 | |
| | **Total after Gate A** | 50 → 100 | |

A gate passes only when every condition the owner set for it holds. If one condition depends on something this
environment cannot provide (for example provider credentials, a human screen-reader pass, real infrastructure), the
gate stays open and the dependency is reported. It is never counted as passed.

## Current

```text
Official Progress: 85%  (unchanged: no further gate has passed every condition)
Completed: Gate A (Phase 6), Gate B (Phase 7 core), Gate C (production infrastructure 7.6–7.13), Gate D (security)
Remaining:
  Gate E: peak heap now < 100 MB in all four final-code runs (76–83 MB); page p95 1,055 ms in one run and capture
          14.5 s in one earlier run, during checkpoint storms on the local default-config PostgreSQL. Needs a re-run on a
          production-like database instance.
  Gate F: manual screen-reader pass (needs a person).
  Gate G: images built and smoke-tested 17/17 (2026-10-10); CI workflow not run on a runner (no git remote here).
  Gate H: real provider accounts, DNS, authorized smoke tests.
Accepted limitations: search plan after bulk import (GIN pending list) — ACCEPTABLE PRE-PRODUCTION. The audience-infra
  "bitmap-repair timing" failure of 2026-10-10 was laptop standby (event log), not a defect.
```
