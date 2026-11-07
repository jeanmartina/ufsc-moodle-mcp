import { createMoodleHttpServer } from "./dist/http-app.js";
import { loadMoodleConfig, redactSecrets } from "./dist/moodle.js";

const config = loadMoodleConfig();
const secrets = [config.token, config.password, process.env.MCP_AUTH_TOKEN];

process.on("uncaughtException", (err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error("ufsc-moodle-mcp: uncaught exception (handled):", redactSecrets(msg, secrets));
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("ufsc-moodle-mcp: unhandled rejection:", redactSecrets(msg, secrets));
});

const PORT = parseInt(process.env.PORT || "8088", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = createMoodleHttpServer({ config });

app.httpServer.listen(PORT, HOST, () => {
  console.log(`UFSC Moodle MCP HTTP Server v1.2.1 listening on ${HOST}:${PORT}`);
  if (process.env.MCP_AUTH_TOKEN) {
    console.log("Bearer / path-token authentication enabled for MCP endpoints");
  }
  console.log(
    `Temporary file capability endpoint enabled (${config.publicBaseUrl ? `${config.publicBaseUrl}/files/<dl_token>/<filename>` : "/files/<dl_token>/<filename>"})`
  );
});

const shutdown = async () => {
  console.log("Shutting down UFSC Moodle MCP server...");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
