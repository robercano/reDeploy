import { loadRepoEnv } from "./env.js";
import { createServer } from "./server.js";

// Load the repo-root .env file (if present) before reading any env-derived
// config below. Real process.env vars always take precedence over the file.
loadRepoEnv();

const rawPort = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : NaN;
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8787;

// Default to loopback — the server will soon hold RPC keys/sensitive state.
// Bind to 0.0.0.0 only when HOST is explicitly overridden in the environment.
const HOST = process.env["HOST"] ?? "127.0.0.1";

const server = createServer();

server.listen(PORT, HOST, () => {
  process.stdout.write(`@redeploy/deploy-server listening on ${HOST}:${PORT}\n`);
});
