// Operator command wrapper (legend-1265 G1): always runs `cli`, so a built
// `node dist/payroll-pph21-receivable-backfill.js` never exits 0 silently because of an entry-file guard.
// Source: `pnpm ...` (tsx). Production: docker compose ... run --rm --no-deps -T api node dist/payroll-pph21-receivable-backfill.js [args]
import { cli } from "../scripts/payroll-pph21-receivable-backfill";

process.exitCode = await cli(process.argv.slice(2));
