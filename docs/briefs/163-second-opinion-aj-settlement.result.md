# Brief 163 — second opinion: settlement + MDR

No findings.

Reviewed branch `ws/aj-settlement`, range `ab1c5aab..abb920e4`, against `docs/design/auto-journals.md` §§1, 4, 8 and the unchanged `gateway_settlement` / `edc_settlement` rules. Application code was reviewed read-only; this report is the only repository file written. No commit or push.

Verified:

- Payloads require safe whole-rupiah amounts, positive gross, nonnegative net and fee, and `grossIdr = netSettledIdr + feeIdr`. Rules debit bank net and fee expense, credit the correct clearing account, and omit zero lines. Gateway events reject `edc_` providers.
- Both settlement facts carry `entryDate: settledOn`; the consumer prefers it over the outlet clock. Closed-period handling moves it to the first open day, retains `settledOn` as `late_adjustment_from`, and audits the adjustment. Retry reconstruction removes stored envelope metadata before strict payload parsing and restores the same date fact.
- Strict-schema Zod errors and envelope/payload outlet mismatches park non-retryable as `AUTO_JOURNAL_PAYLOAD_INVALID`; mapping failures remain retryable and successful sweeps clear their parked rows.
- Keys use the settlement ID or EDC batch ID, with UUID case normalization before key construction. The tenant-and-key advisory lock and existing-journal lookup precede date calculation. Replays are no-ops; lookup and uniqueness cover the whole tenant across outlets, while equal IDs in different tenants remain independent. Relevant outlet, journal, period and parking queries are tenant-scoped.
- Settlement handlers deliberately perform no clearing-balance/backing guard. The range adds no emitter and changes no posting rules, RLS or migrations. Future emitters must enforce §4's one-event-per-payout and stable-ID contract.

Validation: `heavy env LEGEND_TEST_FILES=accounting-auto-journal.test.ts pnpm test` completed with exit 0: **104/104 tests passed**, including **18 AJ-SET cases**, against disposable PostgreSQL. Log: `/tmp/brief163-aj-settlement-20261109.log`. Scoped `git diff --check ab1c5aab..abb920e4` passed. Two read-only subagents ran concurrently (total 2, peak 2); conclusions were checked against the code.

Limits: settlement-specific cross-tenant/cross-outlet key reuse and concurrent delivery were traced statically; the existing suite does not exercise each of those combinations. Full-repository checks, build and real-emitter end-to-end delivery were not run.
