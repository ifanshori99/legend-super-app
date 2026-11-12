# sub-539-u2 fix 6 failing mjmm e2e (regression from c8894367)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-extra`, branch `ui/pos-extra`. Mock dev server for manual look: http://localhost:3243 (don't start/stop servers). No commit.

`e2e/legend-mjmm-pos-kasir.mock.spec.ts` fails at lines 779, 823, 1059, 1070, 1089, 1112 (log: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/7a50c949-91cb-4478-8fbe-e0605817ecac/scratchpad/pw-head.log`). They pass on `origin/milestone/m1`; this branch's commits `c8894367` (held cash-out, blind count, force close: legend-pspy, legend-7mlf) and `a4daa574` changed `features/ws04-pos-kasir` shift/supervisor screens + `shift-extra-*`.

For each failing test decide:

- Deliberate U2 change (founder-approved screens; money rule: "Selisih buku" = physical variance + held correction, held cash-out labelled "Kedaluwarsa, tidak dibukukan", `bookVarianceIdr` mirrors `apps/api/src/services/pos-shift.service.ts:1401-1404`) → update the spec expectation, with a one-line comment why.
- Regression (lost behaviour the old test guarded, e.g. blind count must hide expected cash / "Kas keluar" shows a dash, PIN without reason must show an error) → fix the code, keep the test.
  Never weaken a money or blind-count assertion just to pass.

Run: `heavy pnpm exec playwright test --config=playwright.mock.config.ts e2e/legend-mjmm-pos-kasir.mock.spec.ts --reporter=line > <scratchpad>/pw-mjmm.log 2>&1`, grep summary. Goal 37/37. Report ≤8 lines: per test: cause, spec or code fix, file.
