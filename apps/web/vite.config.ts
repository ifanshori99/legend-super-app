import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { i18nChunks } from "./vite-i18n-chunks.ts";
import { assertNoMockInDeployedBuild } from "./vite-mock-guard.ts";
import { posPrecache } from "./vite-pos-precache.ts";

// Both apps share the repository root's .env.local / .env.
const envDir = resolve(import.meta.dirname, "../..");

// Demo sample menu photos (owner Q17/Q24, legend-4pki) live in `demo/`, not
// `public/`, so a production build never copies them and Nitro's asset manifest
// never lists them. Mock-mode dev serves them from here; a demo build copies
// them into the output (scripts/demo-sample-photos.mjs).
const demoSampleDir = resolve(import.meta.dirname, "demo");
const demoSampleRoot = resolve(demoSampleDir, "sample");
const contentTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function demoSampleAssets(enabled: boolean): Plugin {
  return {
    name: "legend-demo-sample-assets",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (!path.startsWith("/sample/")) return next();
        let decoded: string;
        try {
          decoded = decodeURIComponent(path);
        } catch {
          return next();
        }
        // Stay inside demo/sample/: a `..` (plain or encoded) or a symlink in
        // the URL must not read other files, and only regular files are
        // streamed (a directory would throw EISDIR from the read stream).
        let file: string;
        try {
          file = realpathSync(resolve(demoSampleDir, `.${decoded}`));
          if (
            !file.startsWith(`${realpathSync(demoSampleRoot)}/`) ||
            !statSync(file).isFile()
          )
            return next();
        } catch {
          return next();
        }
        response.setHeader(
          "content-type",
          contentTypes[extname(file).toLowerCase()] ??
            "application/octet-stream",
        );
        response.setHeader("cache-control", "public, max-age=3600");
        createReadStream(file)
          .on("error", () => {
            if (!response.headersSent) response.statusCode = 500;
            response.end();
          })
          .pipe(response);
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Server modules read process.env. In development Vite only exposes VITE_*
  // to the browser, so loading the whole file here never leaks a secret.
  const fileEnv = loadEnv(mode, envDir, "VITE_");
  if (command === "serve") {
    for (const [key, value] of Object.entries(loadEnv(mode, envDir, "")))
      if (process.env[key] === undefined) process.env[key] = value;
  }
  const mockFlag = process.env.VITE_API_MOCK ?? fileEnv.VITE_API_MOCK;
  const demo = mockFlag === "true";
  // A mock bundle must never be built for staging or production (legend-x73li).
  assertNoMockInDeployedBuild({
    command,
    mock: mockFlag,
    deploymentMode:
      process.env.DEPLOYMENT_MODE ??
      loadEnv(mode, envDir, "DEPLOYMENT_MODE").DEPLOYMENT_MODE,
  });
  // The dev server listens on WEB_URL's port, so the origin the API trusts
  // and the address you open always match.
  const port =
    Number(new URL(process.env.WEB_URL || "http://localhost:3000").port) ||
    3000;
  return {
    envDir,
    resolve: {
      tsconfigPaths: true,
      // The demo photo map is swapped at build time (legend-6vki): mock/demo
      // builds get the shared Unsplash map, a normal build an empty stub, so
      // no `/sample/menu` path can enter the production bundle.
      alias: {
        "virtual:demo-photo-map": resolve(
          import.meta.dirname,
          demo
            ? "src/lib/mock/demo-photos.ts"
            : "src/lib/mock/demo-photos-empty.ts",
        ),
      },
    },
    server: { port, strictPort: true },
    // True only while `vite dev` serves the app. Builds always report false,
    // which keeps pino's worker-thread transport (pino-pretty) out of the
    // bundled server: thread-stream uses `__dirname`, which does not exist in
    // Nitro's ES module output. NODE_ENV is not used because Vite inlines
    // whatever value built the bundle. See apps/web/src/lib/logger.server.ts.
    define: { __WEB_DEV_SERVER__: JSON.stringify(command === "serve") },
    // node-server emits .output/server/index.mjs, a portable Node server that
    // honors PORT and HOST. The Dockerfile ships only that folder.
    nitro: {
      preset: "node-server",
      // Runs at server startup, before the port opens: the built server would
      // otherwise load the app (and its env validation) lazily on the first
      // request. See docs/deployment.md ("Startup validation").
      plugins: ["./server/plugins/deployment-env.ts"],
      rolldownConfig: {
        // Libraries ship RSC "use client" directives; this app has no server
        // components, so the bundler's notice about dropping them is noise.
        onwarn(warning: { code?: string }, warn: (warning: never) => void) {
          if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
          warn(warning as never);
        },
      },
    },
    plugins: [
      // Per-area text catalog, and every import of the catalog barrel
      // redirected to its catalog-free runtime (legend-nmn9j).
      i18nChunks({ split: true }),
      tailwindcss(),
      demoSampleAssets(demo),
      posPrecache(),
      tanstackStart(),
      // Nitro is the deployment adapter; development uses Start's own server.
      command === "build" && nitro(),
      // React's plugin must come after Start's.
      viteReact(),
    ],
  };
});
