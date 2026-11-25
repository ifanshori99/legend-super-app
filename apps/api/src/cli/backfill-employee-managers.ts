// Operator command wrapper (legend-1265 G1): always runs `cli`, so a built
// `node dist/backfill-employee-managers.js` never exits 0 silently because of an entry-file guard.
// Source: `pnpm ...` (tsx). Production: docker compose ... run --rm --no-deps -T api node dist/backfill-employee-managers.js [args]
import { cli } from "../db/backfill-employee-managers";

// Source (tsx) loads the repository .env files; the built file runs in a
// container where the real environment (MIGRATION_DATABASE_URL or
// MIGRATION_DATABASE_URL_FILE) is required and no .env file is read.
process.exitCode = await cli(process.argv.slice(2), {
  loadEnv: import.meta.url.endsWith(".ts"),
});
