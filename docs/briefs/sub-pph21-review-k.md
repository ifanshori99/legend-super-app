# Sub-brief: PPh 21 review K fixes (ws/payroll-pph21-tests)

Worktree: `legend/.worktrees/payroll-pph21-tests` (branch `ws/payroll-pph21-tests`, main already merged).
Do NOT commit, do NOT read `.env*`, do NOT `pkill`/`killall` (only your own PIDs). Edit only files of your section.
Run only targeted tests for your files (`pnpm --filter <pkg> exec vitest run <file>`); report exact command + result.
Money: integers in rupiah, no floats leaking; keep existing invariant tests green; do not weaken any existing test.

## A — engine (`packages/shared/src/hris/payroll/pph21.ts` + its tests)

Files: `pph21.ts`, tests `apps/api/src/test/payroll-pph21-annual.test.ts`, `payroll-pph21-ter.test.ts` (add tests, never weaken).
A1 (architect, medium). `pph21.ts:313-322,329-333`: in `gross_first`, when `priorTax = 0` then `employerHistory = 0`,
so the whole Jan–Nov shortfall is cut from a net-scheme employee (e.g. TK/0 net ≤ Rp5.4 jt at TER 0%).
Fix: when `priorTax = 0`, split `history` by the Jan–Nov scheme mix (per-scheme base in `prior`), or by this month's G/X if no prior base.
Regression test next to R64.
A2 (founder decision 2026-11-08). Employer BPJS contributions are in gross (`pph21.ts:34`, `:215`).
For net / gross-up employees the tax on that part is BORNE BY THE COMPANY: it goes into the tax allowance (gross-up),
never reduces take-home. Gross-scheme employees: unchanged. Check what code does now; implement + tests proving
take-home of net and gross-up employees does not drop by the tax on employer BPJS, gross employee unchanged.

## B — run/lock (`apps/api/src/services/payroll-run-pph21.service.ts`, lock caller, `packages/shared/src/hris/payroll/run.ts`)

B1 (architect, medium). `payroll-run-pph21.service.ts:66-71,92-96`: `capturePph21PolicyForLock` reads the policy in its own
transaction, so a v2 published between approve and lock pins v2 while payslips were computed with v1.
Fix: accept `tx`; pin `pph21Policy` from the same computation inside the lock transaction; reject lock with
`PAYROLL_SNAPSHOT_MISMATCH` when the ref differs from the approved one. DB test in `apps/api/src/test/payroll-run-pph21-db.test.ts`.
B2 (low). `run.ts:341-347`: `pph21PolicyForRun` does not compare `parameters`. Store a hash of `parameters` in
`Pph21PolicyRef` and compare it. Stable hash (canonical JSON key order), shared helper usable in api. Test both.

## C — migration upgrade test (new file `apps/api/src/test/payroll-pph21-policy-migration.test.ts`)

Migrations were renumbered: old 0063/0064 (collided with main) now `apps/api/drizzle/0068_payroll_pph21_policy.sql` +
`0069_payroll_pph21_policy_rls.sql`. Follow pattern of `apps/api/src/test/edge-received-events-migration.test.ts`
(scratch DB on test server, dropped in afterAll). Prove: (1) fresh DB migrates full folder → table exists, RLS enabled+forced,
legend_app lacks UPDATE/DELETE/TRUNCATE; (2) DB migrated only up to 0067 (truncated journal copy), then full folder → same result.
Check how existing test gets `STARTER_TEST_DATABASE_URL` / runs (see apps/api vitest config / package scripts).
