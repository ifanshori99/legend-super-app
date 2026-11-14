// Web unit tests (hooks and components rendered on the server, no browser).
// There was no web vitest setup yet (bead 852, finding 4), so this borrows the
// API package's vitest binary; globals avoid a vitest dependency in apps/web.
// Run from the repository root:
//   pnpm --filter @starter/api exec vitest run --root ../web --config ../web/vitest.config.mjs
import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["verbose"],
    environment: "node",
    globals: true,
  },
};
