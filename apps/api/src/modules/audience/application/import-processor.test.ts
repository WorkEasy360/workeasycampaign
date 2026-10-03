import { describe, expect, it } from 'vitest';
import { optionPermissionProblems } from './imports.service.js';
import { isTransientImportError } from './import-processor.js';

describe('import chunk retry classification', () => {
  it('retries pauses, dropped connections, serialization failures and deadlocks', () => {
    expect(isTransientImportError({ code: 'P2028', message: 'Transaction API error: A query cannot be executed on an expired transaction.' })).toBe(true);
    expect(isTransientImportError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientImportError({ code: '40001' })).toBe(true);
    expect(isTransientImportError({ code: '40P01' })).toBe(true);
    expect(isTransientImportError({ message: 'wrapped', cause: { code: 'P1017' } })).toBe(true);
  });

  it('does not retry real errors (constraint violations, bugs, validation)', () => {
    expect(isTransientImportError({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(isTransientImportError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientImportError(null)).toBe(false);
  });
});

describe('import option permissions', () => {
  it('each option needs the permission of the equivalent direct action', () => {
    const importer = new Set(['contacts.read', 'contacts.import']);
    expect(Object.keys(optionPermissionProblems(importer, { listIds: ['l'], tagIds: ['t'], topicIds: ['p'], consent: { channel: 'email', lawfulBasis: 'consent', evidenceNote: 'x' } })).sort()).toEqual([
      'options.consent',
      'options.listIds',
      'options.tagIds',
      'options.topicIds',
    ]);
    const manager = new Set(['contacts.import', 'lists.manage', 'tags.manage', 'consent.manage']);
    expect(optionPermissionProblems(manager, { listIds: ['l'], tagIds: ['t'], topicIds: ['p'], consent: { channel: 'email', lawfulBasis: 'consent', evidenceNote: 'x' } })).toEqual({});
    expect(optionPermissionProblems(importer, { listIds: [], tagIds: [], topicIds: [] })).toEqual({});
  });
});
