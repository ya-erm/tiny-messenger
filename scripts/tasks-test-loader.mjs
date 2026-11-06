// Used only by the isolated Tasks integration test, never by the app server.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  // Next replaces this build-time marker; standalone server tests do likewise.
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  let file;
  if (specifier.startsWith("@/")) file = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    file = fileURLToPath(new URL(specifier, context.parentURL));
  }
  if (file && !path.extname(file)) {
    for (const suffix of [".ts", ".tsx", ".mts", "/index.ts"]) {
      if (existsSync(file + suffix)) return { url: pathToFileURL(file + suffix).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && /\.(?:ts|tsx|mts)$/.test(url)) {
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
