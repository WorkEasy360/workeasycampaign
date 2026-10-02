/**
 * Permission catalogue. Permissions are `module.action` strings; roles are sets of these.
 * Adding a module here is the only change needed for RBAC to cover it.
 */
const MODULES = {
  org: ['read', 'update', 'delete', 'billing'],
  users: ['read', 'invite', 'update', 'remove'],
  roles: ['read', 'manage'],
  contacts: ['read', 'create', 'update', 'delete', 'import', 'export'],
  lists: ['read', 'create', 'update', 'delete'],
  segments: ['read', 'create', 'update', 'delete'],
  topics: ['read', 'manage'],
  consent: ['read', 'manage'],
  scoring: ['read', 'manage'],
  campaigns: ['read', 'create', 'update', 'delete', 'send', 'approve'],
  journeys: ['read', 'create', 'update', 'delete', 'launch', 'approve'],
  templates: ['read', 'create', 'update', 'delete'],
  assets: ['read', 'create', 'delete'],
  forms: ['read', 'create', 'update', 'delete'],
  reports: ['read', 'export'],
  deliverability: ['read', 'manage'],
  integrations: ['read', 'manage'],
  webhooks: ['read', 'manage'],
  api_keys: ['read', 'manage'],
  audit: ['read', 'export'],
} as const;

type Modules = typeof MODULES;
export type Permission = { [M in keyof Modules]: `${M & string}.${Modules[M][number]}` }[keyof Modules];

export const PERMISSIONS: readonly Permission[] = Object.entries(MODULES).flatMap(([m, actions]) =>
  actions.map((a) => `${m}.${a}` as Permission),
);

const ADMIN_ONLY = ['org.', 'users.', 'roles.', 'api_keys.', 'audit.'];
const SETTINGS_MANAGE: Permission[] = [
  'integrations.manage',
  'webhooks.manage',
  'scoring.manage',
  'deliverability.manage',
];

const without = (perms: readonly Permission[], drop: (p: Permission) => boolean) => perms.filter((p) => !drop(p));
const isAdminOnly = (p: Permission) => ADMIN_ONLY.some((prefix) => p.startsWith(prefix));
const isApproval = (p: Permission) => p.endsWith('.approve');

const managerPermissions = without(PERMISSIONS, (p) => isAdminOnly(p) || SETTINGS_MANAGE.includes(p) || isApproval(p));

export const SYSTEM_ROLES = {
  owner: { name: 'Owner', permissions: PERMISSIONS },
  admin: { name: 'Admin', permissions: without(PERMISSIONS, (p) => p === 'org.delete' || p === 'org.billing') },
  manager: { name: 'Manager', permissions: managerPermissions },
  editor: {
    name: 'Editor',
    permissions: without(
      managerPermissions,
      (p) => p === 'campaigns.send' || p === 'journeys.launch' || p === 'consent.manage' || p.endsWith('.export'),
    ),
  },
  analyst: {
    name: 'Analyst',
    permissions: [...PERMISSIONS.filter((p) => p.endsWith('.read')), 'reports.export'] as Permission[],
  },
  viewer: { name: 'Viewer', permissions: PERMISSIONS.filter((p) => p.endsWith('.read')) },
} satisfies Record<string, { name: string; permissions: readonly Permission[] }>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
