import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Agent,
  createOrg,
  emailOf,
  inviteAndAccept,
  resetTestDatabase,
  roleId,
  signUp,
  startTestApp,
  type TestApp,
  userIdOf,
  withOwnerConnection,
} from './support.js';

let t: TestApp;
beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp();
});
afterAll(async () => t?.close());

describe('onboarding: register → verify → organization → first workspace', () => {
  it('makes the creator owner and workspace admin, with audit records and domain events', async () => {
    const owner = await signUp(t, undefined, 'Olivia Owner');
    const created = await owner.post('/v1/organizations', { name: 'Acme Marketing', workspace: { name: 'Main', timezone: 'Asia/Kolkata' } });
    expect(created.status).toBe(201);
    const { organization, workspace } = created.body;
    expect(organization).toMatchObject({ name: 'Acme Marketing', slug: 'acme-marketing', role: { name: 'Owner' } });
    expect(workspace).toMatchObject({ name: 'Main', timezone: 'Asia/Kolkata', status: 'active' });

    const ctx = await owner.put('/v1/me/context', { organizationId: organization.id, workspaceId: workspace.id });
    expect(ctx.status).toBe(200);
    expect(ctx.body.permissions).toEqual(expect.arrayContaining(['org.delete', 'members.invite', 'campaigns.send', 'workspace_members.manage']));

    const members = await owner.get(`/v1/workspaces/${workspace.id}/members`);
    expect(members.body.data).toEqual([expect.objectContaining({ displayName: 'Olivia Owner', role: expect.objectContaining({ name: 'Owner' }) })]);

    const audit = await owner.get(`/v1/organizations/${organization.id}/audit-logs`);
    expect(audit.body.data.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['organization.created', 'workspace.created']));

    const events = await withOwnerConnection((c) =>
      c.query('SELECT type, version, correlation_id, actor_id FROM domain_events WHERE org_id = $1 ORDER BY recorded_at', [organization.id]),
    );
    expect(events.rows.map((e) => e.type)).toEqual(['organization.created', 'membership.added', 'workspace.created', 'workspace_membership.added']);
    expect(new Set(events.rows.map((e) => e.correlation_id)).size).toBe(1); // one request → one correlation id
  });

  it('remembers the selected context on the session', async () => {
    const owner = await signUp(t);
    const { orgId, workspaceId } = await createOrg(owner);
    await owner.put('/v1/me/context', { organizationId: orgId, workspaceId });
    const current = await owner.get('/v1/me/context');
    expect(current.body.organization.id).toBe(orgId);
    expect(current.body.workspace.id).toBe(workspaceId);
  });

  it('Idempotency-Key replays the same result and rejects a different body', async () => {
    const owner = await signUp(t);
    const headers = { 'idempotency-key': 'create-org-0001' };
    const body = { name: 'Idem Co', workspace: { name: 'Main' } };
    const first = await owner.request('POST', '/v1/organizations', body, { headers });
    const second = await owner.request('POST', '/v1/organizations', body, { headers });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.organization.id).toBe(first.body.organization.id);
    expect((await owner.get('/v1/organizations')).body.data).toHaveLength(1);
    const conflict = await owner.request('POST', '/v1/organizations', { ...body, name: 'Other' }, { headers });
    expect(conflict.status).toBe(422);
  });
});

describe('organization isolation (User in Organization A cannot access Organization B)', () => {
  let a: Agent;
  let b: Agent;
  let orgA: { orgId: string; workspaceId: string };
  beforeAll(async () => {
    a = await signUp(t);
    b = await signUp(t);
    orgA = await createOrg(a, 'Org A');
    await createOrg(b, 'Org B');
  });

  it.each([
    ['GET', (o: typeof orgA) => `/v1/organizations/${o.orgId}`],
    ['GET', (o: typeof orgA) => `/v1/organizations/${o.orgId}/members`],
    ['GET', (o: typeof orgA) => `/v1/organizations/${o.orgId}/roles`],
    ['GET', (o: typeof orgA) => `/v1/organizations/${o.orgId}/audit-logs`],
    ['GET', (o: typeof orgA) => `/v1/organizations/${o.orgId}/invitations`],
    ['GET', (o: typeof orgA) => `/v1/workspaces/${o.workspaceId}`],
    ['GET', (o: typeof orgA) => `/v1/workspaces/${o.workspaceId}/members`],
  ])('%s %s answers 404 to an outsider', async (method, path) => {
    const r = await b.request(method, path(orgA));
    expect(r.status).toBe(404);
  });

  it('an outsider cannot modify, delete or invite into another organization', async () => {
    expect((await b.patch(`/v1/organizations/${orgA.orgId}`, { name: 'pwned', version: 1 })).status).toBe(404);
    expect((await b.delete(`/v1/organizations/${orgA.orgId}`, { confirmName: 'Org A' })).status).toBe(404);
    expect((await b.patch(`/v1/workspaces/${orgA.workspaceId}`, { name: 'pwned', version: 1 })).status).toBe(404);
    const inviteRole = await roleId(a, orgA.orgId, 'member');
    expect((await b.post(`/v1/organizations/${orgA.orgId}/invitations`, { email: 'x@example.test', organizationRoleId: inviteRole })).status).toBe(404);
    expect((await a.get(`/v1/organizations/${orgA.orgId}`)).body.name).toBe('Org A');
  });

  it('cannot switch context into another organization', async () => {
    expect((await b.put('/v1/me/context', { organizationId: orgA.orgId, workspaceId: null })).status).toBe(404);
  });

  it('non-UUID ids are 404, not errors', async () => {
    expect((await a.get('/v1/organizations/not-a-uuid')).status).toBe(404);
  });
});

describe('members, workspaces and permissions', () => {
  let owner: Agent;
  let member: Agent;
  let org: { orgId: string; workspaceId: string };
  let ws2: string;

  beforeAll(async () => {
    owner = await signUp(t, undefined, 'Owner');
    member = await signUp(t, undefined, 'Member');
    org = await createOrg(owner, 'Team Org');
    ws2 = (await owner.post(`/v1/organizations/${org.orgId}/workspaces`, { name: 'Second' })).body.id;
    await inviteAndAccept(t, owner, member, org.orgId, 'member', [{ workspaceId: org.workspaceId, roleKey: 'viewer' }]);
  });

  it('the invitee joins with exactly the granted access', async () => {
    const ctx = await member.put('/v1/me/context', { organizationId: org.orgId, workspaceId: org.workspaceId });
    expect(ctx.body.permissions).toContain('campaigns.read');
    expect(ctx.body.permissions).not.toContain('campaigns.create');
    expect((await member.get(`/v1/workspaces/${org.workspaceId}`)).status).toBe(200);
  });

  it('User in Workspace A cannot access Workspace B in the same organization unless explicitly authorized', async () => {
    expect((await member.get(`/v1/workspaces/${ws2}`)).status).toBe(404);
    const workspaces = await member.get(`/v1/organizations/${org.orgId}/workspaces`);
    expect(workspaces.body.data.map((w: { id: string }) => w.id)).toEqual([org.workspaceId]);
    const memberId = await userIdOf(member);
    expect((await owner.put(`/v1/workspaces/${ws2}/members/${memberId}`, { roleId: await roleId(owner, org.orgId, 'editor') })).status).toBe(204);
    expect((await member.get(`/v1/workspaces/${ws2}`)).status).toBe(200);
    expect((await owner.delete(`/v1/workspaces/${ws2}/members/${memberId}`)).status).toBe(204);
    expect((await member.get(`/v1/workspaces/${ws2}`)).status).toBe(404);
  });

  it('Member cannot perform admin-only actions (403) and each denial is audited', async () => {
    expect((await member.patch(`/v1/workspaces/${org.workspaceId}`, { name: 'x', version: 1 })).status).toBe(403);
    expect((await member.get(`/v1/organizations/${org.orgId}/audit-logs`)).status).toBe(403);
    expect((await member.post(`/v1/organizations/${org.orgId}/invitations`, { email: 'q@example.test', organizationRoleId: await roleId(owner, org.orgId, 'member') })).status).toBe(403);
    expect((await member.post(`/v1/organizations/${org.orgId}/workspaces`, { name: 'Mine' })).status).toBe(403);
    expect((await member.patch(`/v1/organizations/${org.orgId}`, { name: 'x', version: 1 })).status).toBe(403);
    const denied = await owner.get(`/v1/organizations/${org.orgId}/audit-logs?action=access.denied`);
    expect(denied.body.data.length).toBeGreaterThanOrEqual(5);
    expect(denied.body.data[0]).toMatchObject({ outcome: 'denied', actor: { displayName: 'Member' } });
  });

  it('Admin can perform permitted actions', async () => {
    const memberId = await userIdOf(member);
    const ver = (await owner.get(`/v1/organizations/${org.orgId}/members`)).body.data.find((m: { userId: string }) => m.userId === memberId).version;
    expect((await owner.patch(`/v1/organizations/${org.orgId}/members/${memberId}`, { roleId: await roleId(owner, org.orgId, 'admin'), version: ver })).status).toBe(204);
    // Admins administer every workspace and can invite.
    expect((await member.get(`/v1/workspaces/${ws2}`)).status).toBe(200);
    const invite = await member.post(`/v1/organizations/${org.orgId}/invitations`, { email: 'new-hire@example.test', organizationRoleId: await roleId(owner, org.orgId, 'member') });
    expect(invite.status).toBe(201);
    // …but cannot escalate beyond their own permissions.
    const makeOwner = await member.post(`/v1/organizations/${org.orgId}/invitations`, { email: 'boss@example.test', organizationRoleId: await roleId(owner, org.orgId, 'owner') });
    expect(makeOwner.status).toBe(403);
    const sneaky = await member.post(`/v1/organizations/${org.orgId}/roles`, { name: 'Sneaky', scope: 'organization', permissions: ['org.delete'] });
    expect(sneaky.status).toBe(403);
    expect((await member.delete(`/v1/organizations/${org.orgId}`, { confirmName: 'Team Org' })).status).toBe(403);
  });

  it('Revoked membership immediately prevents protected access', async () => {
    const memberId = await userIdOf(member);
    expect((await member.get(`/v1/workspaces/${org.workspaceId}`)).status).toBe(200);
    expect((await owner.delete(`/v1/organizations/${org.orgId}/members/${memberId}`)).status).toBe(204);
    expect((await member.get(`/v1/workspaces/${org.workspaceId}`)).status).toBe(404);
    expect((await member.get(`/v1/organizations/${org.orgId}`)).status).toBe(404);
    expect((await member.get('/v1/organizations')).body.data).toEqual([]);
  });

  it('suspension removes access until reactivated', async () => {
    const temp = await signUp(t);
    await inviteAndAccept(t, owner, temp, org.orgId, 'member', [{ workspaceId: org.workspaceId, roleKey: 'viewer' }]);
    const tempId = await userIdOf(temp);
    const version = () => owner.get(`/v1/organizations/${org.orgId}/members`).then((r) => r.body.data.find((m: { userId: string }) => m.userId === tempId).version);
    expect((await owner.patch(`/v1/organizations/${org.orgId}/members/${tempId}`, { status: 'suspended', version: await version() })).status).toBe(204);
    expect((await temp.get(`/v1/workspaces/${org.workspaceId}`)).status).toBe(404);
    expect((await owner.patch(`/v1/organizations/${org.orgId}/members/${tempId}`, { status: 'active', version: await version() })).status).toBe(204);
    expect((await temp.get(`/v1/workspaces/${org.workspaceId}`)).status).toBe(200);
  });

  it('the last owner cannot be removed, demoted or leave', async () => {
    expect((await owner.post(`/v1/organizations/${org.orgId}/leave`)).status).toBe(422);
    const ownerId = await userIdOf(owner);
    expect((await owner.patch(`/v1/organizations/${org.orgId}/members/${ownerId}`, { status: 'suspended', version: 1 })).status).toBe(422);
  });

  it('stale versions are rejected (optimistic concurrency)', async () => {
    const current = (await owner.get(`/v1/organizations/${org.orgId}`)).body.version;
    expect((await owner.patch(`/v1/organizations/${org.orgId}`, { name: 'Team Org 2', version: current })).status).toBe(200);
    const stale = await owner.patch(`/v1/organizations/${org.orgId}`, { name: 'Team Org 3', version: current });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
  });

  it('archived workspaces become read-only, and the last active workspace cannot be archived', async () => {
    expect((await owner.post(`/v1/organizations/${org.orgId}/workspaces/${ws2}/archive`)).status).toBe(200);
    expect((await owner.get(`/v1/workspaces/${ws2}`)).status).toBe(200);
    expect((await owner.patch(`/v1/workspaces/${ws2}`, { name: 'x', version: 2 })).status).toBe(403);
    expect((await owner.post(`/v1/organizations/${org.orgId}/workspaces/${org.workspaceId}/archive`)).status).toBe(422);
    expect((await owner.post(`/v1/organizations/${org.orgId}/workspaces/${ws2}/restore`)).status).toBe(200);
  });
});

describe('invitations', () => {
  it('must be accepted by the invited, verified email and only once', async () => {
    const owner = await signUp(t);
    const invitee = await signUp(t);
    const other = await signUp(t);
    const { orgId } = await createOrg(owner, 'Invite Co');
    await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(invitee), organizationRoleId: await roleId(owner, orgId, 'member') });
    const token = t.mailer.tokenFrom(emailOf(invitee), 'invitation');

    const preview = await other.post('/v1/invitations/preview', { token });
    expect(preview.body).toMatchObject({ organizationName: 'Invite Co', status: 'pending' });
    expect((await other.post('/v1/invitations/accept', { token })).status).toBe(403);
    expect((await invitee.post('/v1/invitations/accept', { token })).status).toBe(200);
    expect((await invitee.post('/v1/invitations/accept', { token })).status).toBe(400);
  });

  it('revoked and superseded invitations stop working; re-inviting a member is a conflict', async () => {
    const owner = await signUp(t);
    const invitee = await signUp(t);
    const { orgId } = await createOrg(owner, 'Revoke Co');
    const memberRole = await roleId(owner, orgId, 'member');
    const first = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(invitee), organizationRoleId: memberRole });
    const firstToken = t.mailer.tokenFrom(emailOf(invitee), 'invitation');
    await owner.post(`/v1/organizations/${orgId}/invitations/${first.body.id}/resend`);
    const resentToken = t.mailer.tokenFrom(emailOf(invitee), 'invitation');
    expect(resentToken).not.toBe(firstToken);
    expect((await invitee.post('/v1/invitations/accept', { token: firstToken })).status).toBe(400);
    expect((await owner.delete(`/v1/organizations/${orgId}/invitations/${first.body.id}`)).status).toBe(204);
    expect((await invitee.post('/v1/invitations/accept', { token: resentToken })).status).toBe(400);

    await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(invitee), organizationRoleId: memberRole });
    expect((await invitee.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(invitee), 'invitation') })).status).toBe(200);
    const again = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(invitee), organizationRoleId: memberRole });
    expect(again.status).toBe(409);
  });
});

describe('custom roles', () => {
  it('can be created, assigned, and not deleted while in use; built-in roles are immutable', async () => {
    const owner = await signUp(t);
    const helper = await signUp(t);
    const { orgId, workspaceId } = await createOrg(owner, 'Roles Co');
    const created = await owner.post(`/v1/organizations/${orgId}/roles`, {
      name: 'Campaign reviewer',
      scope: 'workspace',
      permissions: ['campaigns.read', 'campaigns.approve'],
    });
    expect(created.status).toBe(201);
    expect((await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Bad', scope: 'workspace', permissions: ['org.delete'] })).status).toBe(400);

    await inviteAndAccept(t, owner, helper, orgId, 'member');
    const helperId = await userIdOf(helper);
    expect((await owner.put(`/v1/workspaces/${workspaceId}/members/${helperId}`, { roleId: created.body.id })).status).toBe(204);
    const ctx = await helper.put('/v1/me/context', { organizationId: orgId, workspaceId });
    expect(ctx.body.permissions).toEqual(expect.arrayContaining(['campaigns.read', 'campaigns.approve']));
    expect(ctx.body.permissions).not.toContain('campaigns.create');

    expect((await owner.delete(`/v1/organizations/${orgId}/roles/${created.body.id}`)).status).toBe(409);
    const ownerRole = await roleId(owner, orgId, 'owner');
    expect((await owner.patch(`/v1/organizations/${orgId}/roles/${ownerRole}`, { name: 'Boss', version: 1 })).status).toBe(422);
  });
});

describe('organization deletion', () => {
  it('removes access for every member immediately', async () => {
    const owner = await signUp(t);
    const member = await signUp(t);
    const { orgId, workspaceId } = await createOrg(owner, 'Doomed Co');
    await inviteAndAccept(t, owner, member, orgId, 'member', [{ workspaceId, roleKey: 'viewer' }]);
    expect((await owner.delete(`/v1/organizations/${orgId}`, { confirmName: 'wrong' })).status).toBe(400);
    expect((await owner.delete(`/v1/organizations/${orgId}`, { confirmName: 'Doomed Co' })).status).toBe(204);
    expect((await member.get(`/v1/workspaces/${workspaceId}`)).status).toBe(404);
    expect((await owner.get(`/v1/organizations/${orgId}`)).status).toBe(404);
  });
});

describe('audit export', () => {
  it('exports CSV with formula-injection protection and audits the export itself', async () => {
    const owner = await signUp(t, undefined, '=HYPERLINK("http://evil")');
    const { orgId } = await createOrg(owner, 'Export Co');
    const csv = await owner.get(`/v1/organizations/${orgId}/audit-logs/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body)).not.toMatch(/(^|,)=HYPERLINK/m);
    const log = await owner.get(`/v1/organizations/${orgId}/audit-logs?action=audit.exported`);
    expect(log.body.data).toHaveLength(1);
  });
});
