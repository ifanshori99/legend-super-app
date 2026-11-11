import { defineConfig } from "vitest/config";

// Integration tests run the real Express app, Better Auth, and services
// against a disposable PostgreSQL server. Start them with pnpm test from the
// repository root, which creates that server and supplies its URL.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["verbose"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
    },
    // Business-logic coverage (legend-dd0g). Off unless --coverage is passed
    // (pnpm test:coverage). Scope is domain logic only: services and the shared
    // domain package, not routes, db, UI glue, i18n catalogs or type files.
    coverage: {
      provider: "v8",
      allowExternal: true,
      reportOnFailure: true,
      include: ["src/services/**/*.ts", "**/packages/shared/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/test/**",
        "**/i18n/**",
        "**/types/**",
        "**/index.ts",
        "**/*.d.ts",
      ],
      // Floors sit a few points under the 12 Nov 2026 baseline (statements
      // 87.4, branches 77.22, functions 91.51, lines 89.75) so the gate starts
      // green and only blocks regressions. Raise them as tests land; the PRD
      // target is >= 80 for business logic, and branches (77) are still below.
      thresholds: {
        lines: 85,
        statements: 84,
        functions: 88,
        branches: 72,
      },
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
