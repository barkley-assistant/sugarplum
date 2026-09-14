import { createApp } from "./app";
import { ConfigError, readConfig } from "./config";

try {
  const config = readConfig();
  const app = createApp(config);

  const url = `http://${config.host}:${app.server.port}`;
  console.log(`sugarplum listening on ${url}`);

  async function shutdown(signal: string): Promise<void> {
    console.log(`received ${signal}; shutting down`);
    await app.stop();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}