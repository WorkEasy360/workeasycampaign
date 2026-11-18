import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/env.js';
import { parseWorkeasy360Settings } from './settings.js';

const dev = { appUrl: 'http://localhost:3000', isProduction: false };
const prod = { appUrl: 'https://campaign.workeasy360.com', isProduction: true };
const complete = {
  WORKEASY360_ISSUER: 'https://accounts.workeasy360.com',
  WORKEASY360_CLIENT_ID: 'client-1',
  WORKEASY360_KEY_ID: 'kid-1',
  WORKEASY360_PRIVATE_KEY_FILE: '/run/secrets/workeasy360.pem',
};

describe('WorkEasy360 settings', () => {
  it('is off when nothing is set, and the defaults follow the integration kit when it is on', () => {
    expect(parseWorkeasy360Settings({}, dev)).toBeNull();
    expect(parseWorkeasy360Settings(complete, prod)).toEqual({
      issuer: 'https://accounts.workeasy360.com',
      clientId: 'client-1',
      productCode: 'workeasy_campaign',
      redirectUri: 'https://campaign.workeasy360.com/api/v1/auth/workeasy360/callback',
      postLogoutRedirectUri: 'https://campaign.workeasy360.com/login',
      keyId: 'kid-1',
      privateKeyFile: '/run/secrets/workeasy360.pem',
      scopes: ['openid', 'email', 'profile', 'organization'],
      ssoOnly: false,
      provisionOrganizations: true,
      defaultRole: 'member',
      defaultWorkspaceRole: 'viewer',
      allowInsecureRequests: false,
    });
  });

  it('the product code is configurable', () => {
    expect(parseWorkeasy360Settings({ ...complete, WORKEASY360_PRODUCT_CODE: 'easy_campaign' }, prod)?.productCode).toBe('easy_campaign');
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_PRODUCT_CODE: 'Easy Campaign' }, prod)).toThrow(/PRODUCT_CODE/);
  });

  it('needs all four of issuer, client id, key id and key file, or none', () => {
    expect(() => parseWorkeasy360Settings({ WORKEASY360_ISSUER: complete.WORKEASY360_ISSUER }, prod)).toThrow(/WORKEASY360_CLIENT_ID: required/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_KEY_ID: ' ' }, prod)).toThrow(/WORKEASY360_KEY_ID: required/);
  });

  it('SSO-only needs the integration', () => {
    expect(() => parseWorkeasy360Settings({ WORKEASY360_SSO_ONLY: 'true' }, prod)).toThrow(/WORKEASY360_SSO_ONLY/);
    expect(parseWorkeasy360Settings({ ...complete, WORKEASY360_SSO_ONLY: 'true' }, prod)?.ssoOnly).toBe(true);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_SSO_ONLY: 'yes' }, prod)).toThrow(/true or false/);
  });

  it('the issuer is exact: no trailing slash, https (plain http only for a loopback issuer outside production)', () => {
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_ISSUER: 'https://accounts.workeasy360.com/' }, prod)).toThrow(/trailing slash/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_ISSUER: 'http://accounts.workeasy360.com' }, prod)).toThrow(/https in production/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_ISSUER: 'http://accounts.workeasy360.com' }, dev)).toThrow(/loopback/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_ISSUER: 'http://127.0.0.1:8031' }, prod)).toThrow(/https in production/);
    expect(parseWorkeasy360Settings({ ...complete, WORKEASY360_ISSUER: 'http://127.0.0.1:8031' }, dev)?.allowInsecureRequests).toBe(true);
  });

  it('the redirect and post-logout URIs stay on the app\'s origin, and the callback path is fixed', () => {
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_REDIRECT_URI: 'https://evil.example/api/v1/auth/workeasy360/callback' }, prod)).toThrow(/origin/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_REDIRECT_URI: 'https://campaign.workeasy360.com/callback' }, prod)).toThrow(/the callback is/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_POST_LOGOUT_REDIRECT_URI: 'https://evil.example/' }, prod)).toThrow(/origin/);
  });

  it('scopes must include openid and email; roles come from a fixed list', () => {
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_SCOPES: 'openid profile' }, prod)).toThrow(/must include email/);
    expect(() => parseWorkeasy360Settings({ ...complete, WORKEASY360_DEFAULT_ROLE: 'owner' }, prod)).toThrow(/DEFAULT_ROLE/);
    expect(parseWorkeasy360Settings({ ...complete, WORKEASY360_DEFAULT_WORKSPACE_ROLE: 'none' }, prod)?.defaultWorkspaceRole).toBeNull();
  });

  it('is part of the boot configuration: a bad setting fails boot', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x/y', IDENTITY_DATABASE_URL: 'postgresql://x/y', APP_URL: 'http://localhost:3000' };
    expect(loadConfig(base).workeasy360).toBeNull();
    expect(loadConfig({ ...base, ...complete }).workeasy360?.redirectUri).toBe('http://localhost:3000/api/v1/auth/workeasy360/callback');
    expect(() => loadConfig({ ...base, WORKEASY360_ISSUER: 'https://accounts.workeasy360.com' })).toThrow(/Invalid configuration/);
  });
});
