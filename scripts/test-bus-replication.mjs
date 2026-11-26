// Always use a disposable database, even if invoked in a production checkout.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const directory = mkdtempSync(tmpdir() + "/tm-replication-db-");
const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: "file:" + directory + "/test.db" };
const register = `import { register } from 'node:module'; register(${JSON.stringify(new URL("./tasks-test-loader.mjs", import.meta.url).href)});`;
try {
  for (const args of [["node_modules/prisma/build/index.js", "migrate", "deploy"], ["--conditions=react-server", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "scripts/bus-replication-verify.mts"]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit", timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error("Replication checks failed, exit " + result.status);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
