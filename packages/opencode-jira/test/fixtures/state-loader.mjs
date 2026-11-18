import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Strip-only runtimes (Node 26) reject non-erasable TypeScript such as parameter
// properties, so transform the package sources with esbuild from the dev tree.
const stripOnly = process.features.typescript === "strip";

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && specifier.startsWith(".") && context.parentURL?.startsWith(new URL("../../", import.meta.url).href)) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (stripOnly && url.startsWith(new URL("../../src/", import.meta.url).href) && url.endsWith(".ts")) {
    const { transformSync } = await import("esbuild");
    const { code } = transformSync(readFileSync(fileURLToPath(url), "utf8"), { loader: "ts", format: "esm", sourcefile: fileURLToPath(url) });
    return { format: "module", shortCircuit: true, source: code };
  }
  return next(url, context);
}
