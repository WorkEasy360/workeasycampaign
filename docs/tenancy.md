# Tenancy, ownership and isolation

How Workeasy Campaign keeps organizations and workspaces apart, as implemented in Phase 4.

## Hierarchy

```
Platform
 └── Organization ─── members, roles, invitations, security, audit log, billing (org-owned)
      ├── Workspace ── contacts, audiences, campaigns, journeys, templates, assets, reports (workspace-owned)
      └── Workspace …
User (platform principal) ── sessions, security log, idempotency keys (user-owned)
```

## Ownership classes

| Class | Columns | RLS predicate | Who reads it |
|---|---|---|---|
| **platform** | none | none, or reached only through `SECURITY DEFINER` lookups | system lookups only |
| **user-owned** | `user_id` | `user_id = app.current_user_id()` | the user themselves |
| **organization-owned** | `org_id` | `org_id = app.current_org_id()` | members of that organization (re-checked by AccessGuard) |
| **workspace-owned** | `org_id`, `workspace_id` | `org_id = app.current_org_id() AND workspace_id = app.current_workspace_id()` | users with access to that workspace |
| **globally reusable** | none | none, read-only | everyone (e.g. the permission catalogue, which is code, not data) |

**Composite keys.** Workspace-owned rows always carry `org_id` too. Their foreign key is `(org_id, workspace_id) → workspaces(org_id, id)`, so a row can never point at another organization's workspace.

### Every entity, current and planned

| Entity | Class | Notes |
|---|---|---|
| `identity.local_accounts`, `local_account_tokens`, `login_attempts` | platform (local identity provider) | Schema `identity`, reachable only by role `workeasy_identity`. Dropped when Workeasy SSO replaces local auth. |
| `users` | platform principal | RLS: you see yourself, plus members of the organization in your current context. Rows are created only by `app.link_identity()`. |
| `user_identities` | user-owned | Links (provider, subject) to a user. |
| `sessions` | user-owned | Lookup by token only through `app.resolve_session()`. |
| `security_events` | user-owned, append-only | Written only through `app.record_security_event()`. |
| `idempotency_records` | user-owned | Keys are scoped per user. |
| `organizations` | organization | RLS also lets a user see organizations where they hold an active membership (for the org picker). |
| `roles` | organization | System roles are seeded per organization; custom roles are per organization. |
| `organization_memberships` | organization | The user can also see their own rows across organizations. |
| `workspace_memberships` | organization (keyed by workspace) | Composite FK to the organization membership: you cannot be in a workspace without being in its organization. |
| `invitations` | organization | Lookup by token only through `app.find_invitation()`. |
| `workspaces` | organization | A workspace is a child of its organization. |
| `workspace_settings` | **workspace** | First workspace-owned table; proves workspace-level RLS. |
| `audit_logs` | organization, append-only | `workspace_id` is optional context, not the owner. |
| `domain_events` | organization, append-only | `workspace_id` is set when the aggregate is workspace-owned. |
| `provider_message_routes` | organization (written by tenant), platform lookup | Inbound callbacks resolve their tenant here via `app.resolve_provider_message()`. |
| Contacts, contact identities, custom fields, lists, segments, tags, topics, suppressions *(Phase 5)* | workspace | Tags and topics are per workspace, so brands stay separate. |
| Consent events and consent state *(Phase 5)* | workspace, append-only | Retention policy: organization, with workspace override (spec M8). |
| Consent texts (versioned) *(Phase 5)* | workspace | Immutable once used. |
| Scoring rules *(Phase 5)* | workspace | |
| Campaigns, campaign versions, send runs, deliveries *(6, 9)* | workspace | |
| Templates, assets, brand kit *(7, 8)* | workspace | A shared organization-level library is a possible later addition (org-owned, read by workspaces). |
| Journeys, versions, enrollments, step runs *(10)* | workspace | |
| Engagement events and rollups *(11)* | workspace, append-only | |
| Sender domains and identities *(12)* | **organization** | A domain is verified once and used by many workspaces; each workspace allow-lists which identities it may use. |
| SMS sender IDs, WhatsApp business numbers *(13, 14)* | organization | Same reasoning as sender domains. |
| Integrations and credentials *(15)* | workspace | Credentials are encrypted per organization data key. |
| Webhook endpoints and deliveries *(15)* | workspace | |
| API keys *(15)* | organization | Each key is scoped to specific workspaces and permissions. |
| Plans, usage counters *(21)* | organization | |
| Permission catalogue | globally reusable | Code (`packages/shared`), not data. |

## How context reaches PostgreSQL

`@workeasy/db` does **not** export a database client. Application code receives a transaction already bound to a
context:

```ts
db.withTenant({ orgId, workspaceId, userId }, async (tx) => { … })   // organization / workspace work
db.asUser(userId, async (tx) => { … })                               // the user's own rows only
db.system.resolveSession(hash) / findInvitation(hash) / …            // named SECURITY DEFINER lookups
```

Each call opens a transaction and runs
`set_config('app.org_id' | 'app.workspace_id' | 'app.user_id', value, true)`.
The final `true` makes the setting transaction-local, so it cannot leak to the next request on a pooled connection.

- **Missing context:** `nullif(current_setting(...), '')::uuid` returns NULL, so policies match nothing. Forgetting the context returns **no rows**, never everyone's rows.
- **Malformed ids:** the context is validated as UUIDs before it reaches SQL.

## Where the context comes from (never the client alone)

1. **Who** comes from the session cookie (`AuthenticationGuard`), never from the request body.
2. **Which organization or workspace** comes from the URL (`/v1/organizations/:orgId`, `/v1/workspaces/:workspaceId`). The id is only a key for looking up the **caller's own** membership (`AccessService`):
   - An organization route requires an active membership in an active organization.
   - A workspace route resolves the workspace's organization only through the caller's own explicit workspace membership, or through an organization where the caller holds `workspaces.access_all`. A guessed id from another tenant resolves to nothing, so the answer is **404**.
3. **Permission:** the effective permissions (below) must include the route's permission. Otherwise the answer is **403**, and an `access.denied` audit record is written.
4. The service runs `inTenant(db, ctx, …)` with the **resolved** org and workspace, not the raw path value.

All of this is re-evaluated on **every request**, with no caching. Revoking a membership, suspending someone, changing a role, deactivating a user or deleting an organization takes effect on the next request (tested).

**Remembered context.** The organization/workspace switcher stores the last selection on the session (`PUT /v1/me/context`, which is validated). That is a convenience for the UI only; every API call still carries ids and is re-authorized.

## RBAC

| | Organization scope | Workspace scope |
|---|---|---|
| System roles | Owner, Admin, Member | Workspace admin, Manager, Editor, Analyst, Viewer |
| Assigned through | `organization_memberships.role_id` | `workspace_memberships.role_id` |
| Custom roles | yes | yes |

The **role assignment** is the membership's `role_id`: one role per membership, so access stays explicit and testable.
There are no hidden inheritance chains.

**Effective permissions** (`apps/api/src/modules/tenancy/domain/access-policy.ts`):
1. **Organization:** the permissions of the organization role, and only while the membership is active.
2. **Workspace:** every workspace permission if the organization role holds `workspaces.access_all` (Owner, Admin). Otherwise the explicit workspace role. With neither, there is no access.
3. **Archived workspace:** read permissions only.

**Guard rails** (all tested):
- **Anti-escalation:** you can grant, invite with, or build a role from only the permissions you hold in that scope.
- **Owners:** only an owner can grant the owner role or change another owner.
- **Last owner:** the last active owner cannot be demoted, suspended, removed or leave. This check runs in a SERIALIZABLE transaction.
- **Self-changes:** admin endpoints cannot change your own membership.
- **Built-in roles** are immutable. A custom role that is still assigned cannot be deleted.

## Membership and invitation lifecycle

```
Organization membership:  active ⇄ suspended → removed (row kept for history; re-invite reactivates it)
Workspace membership:     present | deleted (removing an org member deletes their workspace memberships)
Invitation:               pending → accepted | revoked | expired (by time)
                          a new invitation to the same email revokes the pending one; resend rotates the token
Workspace:                active ⇄ archived (read-only); the last active workspace cannot be archived
Organization:             active → deleted (soft; every member loses access immediately)
```

## Background jobs and webhooks

- **Jobs** (`apps/worker/src/jobs/tenant-job.ts`):
  - Every job carries `{ tenant: { orgId, workspaceId }, actor, correlationId, payload }`, built server-side.
  - The wrapper validates the envelope. A missing or invalid tenant raises `UnrecoverableError`: the job never retries and never runs unscoped.
  - The handler gets an RLS-scoped transaction. Even if the payload names another tenant's id, the handler cannot see that tenant (tested).
- **Webhooks:**
  - A provider callback is verified against the raw body (`ChannelAdapter.verifyCallback`).
  - Its tenant is resolved from `provider_message_routes` through `app.resolve_provider_message()`, never from payload fields (tested at database level).

## Analytics

- Aggregates run inside `withTenant` and cover exactly one tenant.
- The `workeasy_reporting` role is also subject to RLS: with no context it sees nothing (tested).
- Cross-tenant platform analytics need a separate, explicitly authorized path over anonymized aggregates. That path does not exist yet, by design.

## Tests that prove it

| What | Where |
|---|---|
| A cannot SELECT, INSERT, UPDATE or DELETE B's rows; composite FKs; immutable tenant keys; missing context = no rows; no leakage between pooled connections | `packages/db/test/rls.test.ts` |
| Workspace A2 cannot read A1; an A context cannot read B's workspace even with its id | `packages/db/test/rls.test.ts` |
| Every table has forced RLS; runtime roles cannot bypass it; history tables are append-only; definer functions are pinned | `packages/db/test/security-invariants.test.ts` |
| HTTP: outsider gets 404, member without permission gets 403 (audited), revocation, suspension, deletion, escalation, last owner | `apps/api/test/tenancy.test.ts` |
| Every route has an access policy, and anonymous callers get 401 | `apps/api/test/routes.test.ts` |
| Jobs keep tenant context | `apps/worker/test/tenant-job.test.ts` |
| Browser: viewer cannot see admin controls; the API refuses the direct call; removal ends access | `apps/e2e/tests/phase4.spec.ts` |
