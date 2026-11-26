import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const settings = Object.fromEntries((await readFile(path.join(root, "deploy/release.env"), "utf8")).trim().split("\n").map((line) => line.split("=")));
const ts = createRequire(import.meta.url)(path.join(settings.MESSENGER_DEPENDENCIES_DIR, "typescript"));
const output = path.join(root, "cloud/yandex/shared");
await mkdir(output, { recursive: true });
const files = { "admin-data":"src/lib/admin/data.ts", "attachment-thumbnail":"src/lib/attachment-thumbnail.ts", "admin-protocol":"src/lib/admin/protocol.ts", "external-protocol":"src/lib/replication/external-protocol.ts", "yandex-protocol":"src/lib/yandex/protocol.ts", "yandex-service":"src/lib/yandex/service.ts", "telemetry-protocol":"src/lib/replication/telemetry-protocol.ts", "identity-protocol":"src/lib/replication/identity-protocol.ts", "users-protocol":"src/lib/replication/users-protocol.ts", "names":"src/lib/names.ts", "constants":"src/lib/constants.ts", "protocol": "src/lib/mutations/protocol.ts", "reduce": "src/lib/mutations/reduce.ts", "reactions": "src/lib/reactions.ts", "replication": "src/lib/replication/protocol.ts", "rows": "src/lib/replication/rows.ts", "attachment-types": "src/lib/attachment-types.ts", "attachment-config": "src/lib/attachment-config.ts", "attachment-storage": "src/lib/attachment-storage.ts" };
const hashes = {};
for (const [name, file] of Object.entries(files)) {
  const source = await readFile(path.join(root, file), "utf8");
  hashes[file] = createHash("sha256").update(source).digest("hex");
  const compiled = ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('import "server-only";', '').replaceAll('"@/lib/constants"', '"./constants.mjs"').replaceAll('"@/lib/api"', '"../src/errors.mjs"').replaceAll('"@/lib/attachment-config"', '"./attachment-config.mjs"')
    .replaceAll('"../reactions"', '"./reactions.mjs"').replaceAll('"./protocol"', '"./protocol.mjs"').replaceAll('"./data"','"./admin-data.mjs"').replaceAll('"./users-protocol"', '"./users-protocol.mjs"').replaceAll('"../replication/external-protocol"', '"./external-protocol.mjs"');
  await writeFile(path.join(output, name + ".mjs"), name==="yandex-service"?compiled.replaceAll('"./protocol.mjs"','"./yandex-protocol.mjs"'):compiled);
}
for (const name of ["format", "ymq", "transport"]) {
  const source = await readFile(path.join(root, "scripts/replication-bus/" + name + ".mjs"), "utf8");
  await writeFile(path.join(output, "bus-" + name + ".mjs"), source.replaceAll('"./ymq.mjs"', '"./bus-ymq.mjs"'));
}
await writeFile(path.join(output, "source-hashes.json"), JSON.stringify(hashes, null, 2));
console.log("Cloud protocol generated from the VPS source files.");
