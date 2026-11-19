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
const files = { "protocol": "src/lib/mutations/protocol.ts", "reduce": "src/lib/mutations/reduce.ts", "reactions": "src/lib/reactions.ts" };
const hashes = {};
for (const [name, file] of Object.entries(files)) {
  const source = await readFile(path.join(root, file), "utf8");
  hashes[file] = createHash("sha256").update(source).digest("hex");
  const compiled = ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"../reactions"', '"./reactions.mjs"').replaceAll('"./protocol"', '"./protocol.mjs"');
  await writeFile(path.join(output, name + ".mjs"), compiled);
}
await writeFile(path.join(output, "source-hashes.json"), JSON.stringify(hashes, null, 2));
console.log("Cloud protocol generated from the VPS source files.");
