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
    // Operator commands run inside the image, which has no tsx or pnpm. Each
    // entry always runs (no "am I the entry file" guard): the src/cli/ wrappers
    // call the module's `cli`, the others run at import. A wrong argument exits
    // non-zero with a usage line (apps/api/src/test/ops-dist-entries.test.ts).
    "payroll-pph21-receivable-backfill":
      "src/cli/payroll-pph21-receivable-backfill.ts",
    "backfill-ptkp-history": "src/db/backfill-ptkp-history.ts",
    "backfill-tenant-defaults": "src/db/backfill-tenant-defaults.ts",
    "metrics-daily-backfill": "src/cli/metrics-daily-backfill.ts",
    "backfill-employee-managers": "src/cli/backfill-employee-managers.ts",
    "rotate-data-key": "src/cli/rotate-data-key.ts",
    "set-role": "src/set-role.ts",
    "purchase-return-variance-check":
      "src/cli/purchase-return-variance-check.ts",
    "repair-supplier-invoice-npwp": "src/db/repair-supplier-invoice-npwp.ts",
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
