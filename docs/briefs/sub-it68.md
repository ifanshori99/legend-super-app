# Sub-brief: legend-it68 waste rounding across business dates (tier K, money)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fix-it68`, branch `ws/fix-it68` (from m1). Do not commit.

## Bug

`apps/api/src/services/inventory-gl-consumer.ts` (~:425-450): rows of one source are grouped per outlet business date; for `waste` each group rounds `Σ -qty × unitCost` once (`scaledCostToIdr`). One FEFO waste log whose rows straddle the business-day cutoff (Rp0,4 + Rp0,4) has `waste_logs.value_idr = 1` but both groups round to 0 → no journal, rows marked done. Rupiah lost.

## Fix (P1 implementer, `inventory-gl-consumer.ts` only)

- Waste only: compute the exact scaled value of EVERY ledger row of the source (posted or not — query without the `isNull(postings)` filter, same movement types), grouped per business date. Total = `scaledCostToIdr(Σ all)` (= waste_logs.value_idr). Allocate whole rupiah to date groups by largest remainder: each group gets floor of its |scaled| / COST_PRODUCT_SCALE, the leftover units go to groups with the largest fractional remainder, ties → oldest date first. Deterministic, so a replay or a later posting of a parked group gets the same amount. Signs: waste groups share one sign; apply the sign after allocating absolutes (if signs differ, throw/keep old behaviour — note it).
- Then post only the groups that still have unposted rows, with their allocated amount (unchanged idempotency key / posting rows). A group allocated 0 still marks its rows done (as today).
- count/order variants unchanged.
- Export the allocation as a small pure function (e.g. `allocateRoundedIdr(scaledParts: bigint[], scale): number[]`) for a unit test.

## Tests (P2 test-writer)

- `apps/api/src/test/inventory-gl.test.ts`: add INV-GL-WASTE-02: a waste log with two batches whose rows land on two business dates (straddle the cutoff), values Rp0,4 + Rp0,4 → Σ journals over both dates = waste_logs.value_idr (1), exactly one date gets 1. Plus a case where one date's period is closed (parked) then reopened/swept: total still equals value_idr. Follow existing waste test fixtures (INV-GL-WASTE-01 ~:635).
- A unit test for the allocation function (new `apps/api/src/test/inventory-gl-allocation.unit.test.ts`): sums preserved, ties oldest-first, all-integer parts unchanged.
- Run: `LEGEND_TEST_FILES="src/test/inventory-gl.test.ts src/test/inventory-gl-allocation.unit.test.ts" pnpm test` from worktree root.
