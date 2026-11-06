// Always use disposable data, regardless of the caller's DATABASE_URL/key.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), "tiny-messenger-tasks-test-"));
const keyFile = path.join(directory, "integration.key");
writeFileSync(keyFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: `file:${path.join(directory, "messenger.db")}`,
  TASKS_ORIGIN: "https://tasks.example.test",
  TASKS_INTEGRATION_SECRET_FILE: keyFile,
  TASKS_TEST_DIR: directory,
};
// Do not inherit Node preload hooks or a production integration credential.
delete env.NODE_OPTIONS;
delete env.TASKS_API_TOKEN;

function run(args) {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit", timeout: 90_000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error(`Tasks integration check failed (exit ${child.status})`);
}

try {
  run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  const register = `import { register } from 'node:module'; register(${JSON.stringify(new URL("./tasks-test-loader.mjs", import.meta.url).href)});`;
  run(["--conditions=react-server", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "scripts/tasks-integration-verify.mts"]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
