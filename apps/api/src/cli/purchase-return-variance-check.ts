// Operator command wrapper (legend-1265 G1): always runs `cli`, so a built
// `node dist/purchase-return-variance-check.js` never exits 0 silently because of an entry-file guard.
// Source: `pnpm ...` (tsx). Production: docker compose ... run --rm --no-deps -T api node dist/purchase-return-variance-check.js [args]
import { cli } from "../scripts/purchase-return-variance-check";

process.exitCode = await cli(process.argv.slice(2));
