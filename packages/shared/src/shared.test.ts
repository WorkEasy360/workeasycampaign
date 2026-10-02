import { describe, expect, it } from 'vitest';
import { canTransition } from './campaigns.js';
import { PERMISSIONS, SYSTEM_ROLES } from './permissions.js';

describe('campaign state machine', () => {
  it('allows pausing a sending campaign but not completing a draft', () => {
    expect(canTransition('sending', 'paused')).toBe(true);
    expect(canTransition('draft', 'completed')).toBe(false);
  });

  it('treats stopped and completed as terminal', () => {
    expect(canTransition('completed', 'sending')).toBe(false);
    expect(canTransition('stopped', 'sending')).toBe(false);
  });
});

describe('system roles', () => {
  it('gives the owner every permission', () => {
    expect(SYSTEM_ROLES.owner.permissions).toEqual(PERMISSIONS);
  });

  it('lets editors create but not send or launch', () => {
    expect(SYSTEM_ROLES.editor.permissions).toContain('campaigns.create');
    expect(SYSTEM_ROLES.editor.permissions).not.toContain('campaigns.send');
    expect(SYSTEM_ROLES.editor.permissions).not.toContain('journeys.launch');
  });

  it('lets managers send but not approve or manage users', () => {
    expect(SYSTEM_ROLES.manager.permissions).toContain('campaigns.send');
    expect(SYSTEM_ROLES.manager.permissions).not.toContain('campaigns.approve');
    expect(SYSTEM_ROLES.manager.permissions).not.toContain('users.invite');
  });
});
