import { createApp } from './app.factory.js';
import { loadConfig, loadDotEnvForDevelopment } from './config/env.js';

async function main() {
  loadDotEnvForDevelopment();
  // Throws with a list of problems if configuration is incomplete or unsafe — the process must not start.
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
  console.log(`API listening on :${config.port} (${config.env})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
