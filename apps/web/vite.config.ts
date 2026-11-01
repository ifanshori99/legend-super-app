import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Both apps share the repository root's .env.local / .env.
const envDir = resolve(import.meta.dirname, "../..");

export default defineConfig(({ command, mode }) => {
  // Server modules read process.env. In development Vite only exposes VITE_*
  // to the browser, so loading the whole file here never leaks a secret.
  if (command === "serve") {
    for (const [key, value] of Object.entries(loadEnv(mode, envDir, "")))
      if (process.env[key] === undefined) process.env[key] = value;
  }
  // The dev server listens on WEB_URL's port, so the origin the API trusts
  // and the address you open always match.
  const port =
    Number(new URL(process.env.WEB_URL || "http://localhost:3000").port) ||
    3000;
  return {
    envDir,
    resolve: { tsconfigPaths: true },
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
      tailwindcss(),
      tanstackStart(),
      // Nitro is the deployment adapter; development uses Start's own server.
      command === "build" && nitro(),
      // React's plugin must come after Start's.
      viteReact(),
    ],
  };
});
