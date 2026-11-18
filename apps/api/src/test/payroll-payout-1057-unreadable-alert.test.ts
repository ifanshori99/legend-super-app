// Payout 1057 card D (bead legend-qh11l, tier K: money): the ops alert for a
// proof file that stays unreadable. Written from the card's rule, NOT from the
// implementation: alert when the unreadable count stays above zero for >= 2
// cycles in a row, or for >= 24 hours; a cycle with zero unreadable resets;
// each tenant is tracked on its own.
//
// Contract used (from the brief): pure helper
//   trackUnreadable(state, tenantId, unreadable, nowMs) => { alert, cycles, sinceMs }
// exported by worker/payout-trusted-recon.job.ts. Assumptions:
// - `state` is an empty Map the caller owns (new Map()), mutated by the helper.
// - `sinceMs` is the elapsed milliseconds since the first unreadable cycle of the
//   current streak (0 on the first cycle and when reset).
// - `cycles` counts consecutive cycles with unreadable > 0 (0 after a reset).
import { describe, expect, it } from "vitest";
import { trackUnreadable } from "../worker/payout-trusted-recon.job.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 18, 1, 0, 0);
const A = "tenant-a";
const B = "tenant-b";
const fresh = () => new Map() as Parameters<typeof trackUnreadable>[0];

describe("1057 card D: unreadable proof alert tracking", () => {
  it("[1057-alert-clean-cycle-no-alert] a cycle with nothing unreadable raises no alert and counts no cycle", () => {
    const state = fresh();
    const r = trackUnreadable(state, A, 0, T0);
    expect(r.alert).toBe(false);
    expect(r.cycles).toBe(0);
  });

  it("[1057-alert-single-cycle-no-alert] one unreadable cycle is transient: no alert, one cycle counted", () => {
    const state = fresh();
    const r = trackUnreadable(state, A, 3, T0);
    expect(r.alert).toBe(false);
    expect(r.cycles).toBe(1);
    expect(r.sinceMs).toBe(0);
  });

  it("[1057-alert-two-cycles-alerts] unreadable in two consecutive cycles alerts", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    const r = trackUnreadable(state, A, 1, T0 + 5 * 60_000);
    expect(r.cycles).toBe(2);
    expect(r.alert).toBe(true);
  });

  it("[1057-alert-keeps-alerting-while-persistent] a third unreadable cycle still reports an alert with three cycles", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    trackUnreadable(state, A, 1, T0 + 60_000);
    const r = trackUnreadable(state, A, 2, T0 + 120_000);
    expect(r.cycles).toBe(3);
    expect(r.alert).toBe(true);
  });

  it("[1057-alert-24-hours-alerts] a single cycle seen 24 hours after the streak began alerts", () => {
    const state = fresh();
    // The streak started at T0; the cycles in between were reset-free but we only
    // check the age rule: first sighting, then a read 24 h later.
    trackUnreadable(state, A, 1, T0);
    const r = trackUnreadable(state, A, 1, T0 + 24 * HOUR);
    expect(r.alert).toBe(true);
    expect(r.sinceMs).toBeGreaterThanOrEqual(24 * HOUR);
  });

  it("[1057-alert-just-under-24-hours-alerts-by-cycles] under 24 hours the age is reported exactly, and the alert comes from the two-cycle rule", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    const r = trackUnreadable(state, A, 1, T0 + 24 * HOUR - 1);
    expect(r.sinceMs).toBe(24 * HOUR - 1);
    expect(r.cycles).toBe(2);
    expect(r.alert).toBe(true);
  });

  it("[1057-alert-reset-on-clean-cycle] a clean cycle ends the streak: the next unreadable cycle counts as the first again", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    const clean = trackUnreadable(state, A, 0, T0 + 60_000);
    expect(clean.alert).toBe(false);
    expect(clean.cycles).toBe(0);
    const again = trackUnreadable(state, A, 1, T0 + 120_000);
    expect(again.cycles).toBe(1);
    expect(again.alert).toBe(false);
    expect(again.sinceMs).toBe(0);
  });

  it("[1057-alert-reset-clears-age] after a reset an old first sighting does not trigger the 24 hour rule", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    trackUnreadable(state, A, 0, T0 + HOUR);
    const r = trackUnreadable(state, A, 1, T0 + 30 * HOUR);
    expect(r.alert).toBe(false);
    expect(r.cycles).toBe(1);
    expect(r.sinceMs).toBe(0);
  });

  it("[1057-alert-tenants-are-independent] tenant B's unreadable cycles neither alert nor reset tenant A", () => {
    const state = fresh();
    trackUnreadable(state, A, 1, T0);
    const b1 = trackUnreadable(state, B, 1, T0 + 60_000);
    expect(b1.cycles, "B is on its first cycle").toBe(1);
    expect(b1.alert).toBe(false);
    const bClean = trackUnreadable(state, B, 0, T0 + 120_000);
    expect(bClean.cycles).toBe(0);
    const a2 = trackUnreadable(state, A, 1, T0 + 180_000);
    expect(a2.cycles, "A kept its streak").toBe(2);
    expect(a2.alert).toBe(true);
  });
});
