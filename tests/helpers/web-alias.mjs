// Lets plain `node --test` load web feature files that import through the
// `@/` alias (apps/web/src) or leave the extension off a relative import.
// Call `registerWebAlias()` BEFORE the dynamic `await import(...)` of such a
// file: static imports are resolved before any code runs.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const hooks = `
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const SRC = ${JSON.stringify(new URL("../../apps/web/src/", import.meta.url).href)};
const TRY = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
function find(base) {
  for (const suffix of TRY) {
    const url = new URL(base.href + suffix);
    const path = fileURLToPath(url);
    if (existsSync(path) && statSync(path).isFile()) return url.href;
  }
  return null;
}
// Vite injects import.meta.env; plain Node has none (lib/env.ts reads it).
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith(SRC) && result.source != null) {
    const text = String(result.source);
    if (text.includes("import.meta.env"))
      return { ...result, source: text.replaceAll("import.meta.env", "(import.meta.env ?? {})") };
  }
  return result;
}
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const hit = find(new URL(specifier.slice(2), SRC));
    if (hit) return next(hit, context);
  } else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith(SRC)
  ) {
    const hit = find(new URL(specifier, context.parentURL));
    if (hit) return next(hit, context);
  }
  return next(specifier, context);
}
`;

let done = false;
export function registerWebAlias() {
  if (done) return;
  done = true;
  // Vite `define` constant read by lib/logger.server.ts.
  globalThis.__WEB_DEV_SERVER__ ??= false;
  register(
    "data:text/javascript," + encodeURIComponent(hooks),
    pathToFileURL("./"),
  );
}
