import { createApp } from './app.factory.js';
import { loadConfig, loadDotEnvForDevelopment } from './config/env.js';

async function main() {
  loadDotEnvForDevelopment();
  // Throws with a list of problems if configuration is incomplete or unsafe — the process must not start.
  const config = loadConfig();
  const app = await createApp(config);
  const roles = [...config.processRoles].join(',');
  if (config.processRoles.has('http')) {
    await app.listen(config.port, '0.0.0.0');
    console.log(`API listening on :${config.port} (${config.env}; roles ${roles}; jobs ${config.jobQueue})`);
  } else {
    // A worker process (e.g. PROCESS_ROLES=jobs,scheduler): no HTTP server; the queue runner and scheduler run.
    await app.init();
    console.log(`Worker started (${config.env}; roles ${roles}; jobs ${config.jobQueue})`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
