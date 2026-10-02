import { describe, expect, it } from 'vitest';
import { registerRequest } from './api/auth.js';
import { createOrganizationRequest } from './api/tenancy.js';
import { PERMISSIONS, isPermission, permissionsForScope } from './permissions.js';

describe('permission catalogue', () => {
  it('splits every permission into exactly one scope', () => {
    const org = permissionsForScope('organization');
    const ws = permissionsForScope('workspace');
    expect(org.length + ws.length).toBe(PERMISSIONS.length);
    expect(org).toContain('members.invite');
    expect(ws).toContain('campaigns.send');
  });

  it('recognises only catalogued permissions', () => {
    expect(isPermission('campaigns.send')).toBe(true);
    expect(isPermission('campaigns.launch_missiles')).toBe(false);
    expect(isPermission('toString')).toBe(false);
  });
});

describe('request contracts', () => {
  it('rejects short passwords and normalises email whitespace', () => {
    const bad = registerRequest.safeParse({ email: ' a@b.co ', password: 'short', displayName: 'A' });
    expect(bad.success).toBe(false);
    const ok = registerRequest.parse({ email: ' a@b.co ', password: 'long-enough-pw', displayName: 'A' });
    expect(ok.email).toBe('a@b.co');
  });

  it('lower-cases and validates organization slugs', () => {
    const r = createOrganizationRequest.parse({ name: 'Acme', slug: 'Acme-Co', workspace: { name: 'Main' } });
    expect(r.slug).toBe('acme-co');
    expect(r.workspace.timezone).toBe('UTC');
    expect(createOrganizationRequest.safeParse({ name: 'A', slug: 'a--b', workspace: { name: 'M' } }).success).toBe(
      false,
    );
  });
});
