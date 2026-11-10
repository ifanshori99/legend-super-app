// Production runner for the one-off pre-switch refund reset (legend-d21p,
// legend-8cf3). Run from the migrator image through
// deploy/single-vm/reset-preswitch-refunds.sh (see docs/deployment.md), which
// passes DOIT_REFUNDS_ENABLED in; --apply exits 2 without it:
//   node dist/reset-preswitch-refunds.js [--dry-run | --apply --touched-before <ISO> --ids <file>]
// Local development keeps using `pnpm db:reset-preswitch-refunds`.
//
// Reads MIGRATION_DATABASE_URL, or MIGRATION_DATABASE_URL_FILE, a path to a
// file holding the URL. Never prints a URL or password. Deliberately does not
// load .env files. Exit codes: 2 usage, 1 abort or error, 0 ok.
import { cli } from "./db/reset-preswitch-refund-payouts";

process.exitCode = await cli(process.argv.slice(2), { loadEnv: false });
