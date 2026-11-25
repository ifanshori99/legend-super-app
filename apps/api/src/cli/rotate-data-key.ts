// Operator command wrapper (legend-1265 G1): always runs `cli`, so a built
// `node dist/rotate-data-key.js` never exits 0 silently because of an entry-file guard.
// Source: `pnpm ...` (tsx). Production: docker compose ... run --rm --no-deps -T api node dist/rotate-data-key.js [args]
import { cli } from "../db/rotate-data-key";

process.exitCode = await cli(process.argv.slice(2));
