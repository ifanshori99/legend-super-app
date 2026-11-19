# 1167 final gate (test-runner, sequential, one heavy at a time)

cwd worktree root. Scratch: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-69fdb95b/aa16783a-513f-4f44-8fe7-a52767c126b9/scratchpad
Do not edit files. Run in background, wait with Monitor until-loop. Report only exit/summary lines and FAIL names with 3 lines of error.

1. Terarah: `F=$(for f in $(cat $SCRATCH/files.txt); do echo -n "src/test/$f "; done); LEGEND_TEST_FILES="$F" heavy pnpm test > $SCRATCH/green2.log 2>&1`
2. Typecheck API: `heavy pnpm --filter @starter/api typecheck > $SCRATCH/tsc.log 2>&1` (also `heavy pnpm --filter @starter/shared typecheck` if script exists). Report error lines.
3. inflf: run 3 times the 3 payout recon files: `LEGEND_TEST_FILES="src/test/payroll-payout-990-recon-attest.test.ts src/test/payroll-payout-990-recon-clear.test.ts" heavy pnpm test` (use `ls apps/api/src/test | awk '{print $1}' | grep payroll-payout-990` to find the real names; run all that match, together, 3 times back to back). Report pass/fail of each run.
4. `pnpm db:generate` must produce no new files (report `git status --short apps/api/drizzle`).
