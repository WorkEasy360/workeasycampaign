// `pnpm dev` only (preloaded by the dev script): marks the process as development so the API loads the repository .env
// (config/env.ts loadDotEnvForDevelopment). Production and tests never use this file; production defaults stay strict.
process.env.NODE_ENV ??= 'development';
