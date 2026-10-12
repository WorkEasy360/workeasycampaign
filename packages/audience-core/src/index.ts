/**
 * @workeasy/audience-core — the Audience context's read side as pure rules and ports
 * (docs/contracts/phase-5-audience.md §9.8, ADR D-7). Depends only on @workeasy/shared and Node built-ins:
 * no database, no framework, no I/O. Implementations of the ports live in @workeasy/audience-infra.
 */
export * from './consent-state.js';
export * from './fingerprint.js';
export * from './eligibility.js';
export * from './evaluator.js';
export * from './ports.js';
export * from './audience-definition.js';
