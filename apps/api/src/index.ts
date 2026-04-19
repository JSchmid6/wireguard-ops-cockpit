import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp({ config });

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
  console.log(`control-api listening on http://${config.apiHost}:${config.apiPort}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

