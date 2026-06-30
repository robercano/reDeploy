import { createServer } from "./server.js";

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 8787;

const server = createServer();

server.listen(PORT, () => {
  process.stdout.write(`@redeploy/deploy-server listening on port ${PORT}\n`);
});
