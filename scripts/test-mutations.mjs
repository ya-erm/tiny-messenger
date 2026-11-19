// Always migrate a disposable database. Never inherit the production DB URL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), "tiny-messenger-mutations-test-"));
const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: `file:${path.join(directory, "messenger.db")}`,
  RATE_LIMIT_MESSAGES_BURST: "1000", RATE_LIMIT_MESSAGES_PER_MINUTE: "1000" };
delete env.NODE_OPTIONS;
delete env.TASKS_INTEGRATION_SECRET_FILE;

function run(args) {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit", timeout: 90_000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error(`Mutation checks failed (exit ${child.status})`);
}
try {
  run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  const register = `import { register } from 'node:module'; register(${JSON.stringify(new URL("./tasks-test-loader.mjs", import.meta.url).href)});`;
  const loader = ["--conditions=react-server", "--import", `data:text/javascript,${encodeURIComponent(register)}`];
  run([...loader, "scripts/mutations-verify.mts"]);
  run([...loader, "scripts/mutations-convergence-verify.mts"]);
  run([...loader, "scripts/mutations-restart-verify.mts"]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
