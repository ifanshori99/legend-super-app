// Unit tests of web code that runs without a browser (mock handlers). Kept apart
// from vite.config.ts on purpose: that one loads the TanStack Start plugins,
// which a unit test neither needs nor wants. Plain object (no `defineConfig`
// import) so it loads even before `vitest` is linked into this workspace.
//
// Run from the repo root: `pnpm --filter @starter/web exec vitest run <file>`.
import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["verbose"],
  },
};
