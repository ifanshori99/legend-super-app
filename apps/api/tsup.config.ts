import { defineConfig } from "tsup";

// Bundles the server and the migrator into self-contained ESM files, including
// @starter/shared (TypeScript source) and npm dependencies, so the production
// image ships only dist/ and drizzle/ — no node_modules. Native packages
// (sharp) are the exception: they load a platform .node binary from their own
// package directory, so they stay external and the image installs them.
export default defineConfig({
  entry: {
    server: "src/server.ts",
    migrate: "src/migrate.ts",
    "provision-roles": "src/provision-roles.ts",
    "predeploy-check": "src/predeploy-check.ts",
    "reset-preswitch-refunds": "src/reset-preswitch-refunds.ts",
    "set-gateway": "src/set-gateway.ts",
    // Release gate: dry-run then apply inside the image, which has no tsx
    // (docs/release/pph21-backfill-rehearsal.md).
    "payroll-pph21-receivable-backfill":
      "src/scripts/payroll-pph21-receivable-backfill.ts",
    worker: "src/worker-main.ts",
    // Loaded by services/pdf-safety.ts as `new Worker(dist/pdf-safety.worker.js)`;
    // it must sit beside the server chunks in dist/ (legend-851ef).
    "pdf-safety.worker": "src/services/pdf-safety.worker.ts",
  },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // apps/api/assets/ is copied into dist/ (dist/fonts/ holds the Noto Sans
  // subsets the PO PDF renderer reads at runtime), so the image still ships
  // only dist/ and drizzle/.
  publicDir: "assets",
  sourcemap: true,
  splitting: true,
  // noExternal wins over external, so the native packages are excluded here.
  noExternal: [/^(?!sharp(\/|$)|@img\/).*/],
  // Optional native bindings and dev-only transports are never loaded in production.
  // sharp (and its @img/* platform binaries) is loaded in production, so it must
  // be installed next to dist/ at runtime (see apps/api/Dockerfile).
  external: ["pg-native", "pino-pretty", "sharp", /^@img\//],
  // Some CommonJS dependencies call require() at runtime.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
