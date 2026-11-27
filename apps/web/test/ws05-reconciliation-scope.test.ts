// C4b review P3-3 (legend-osqou.8): the reconciliation panel's open cases and
// summary stay tenant-wide (no outletId, the API checks payment.reconcile at
// tenant level), so a difference at another outlet is never hidden. The outlet
// picker scopes the settlement list only, defaulting to the first outlet. The
// import link carries that outlet (UI audit P2-5).
//
// Server-rendered, no browser: the data hooks are stubbed and record their
// arguments.
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ReconciliationPanel } from "@/features/ws05-payment-admin/components/reconciliation-panel";

const calls = vi.hoisted(() => ({
  summary: [] as unknown[],
  cases: [] as unknown[],
  settlements: [] as unknown[],
  links: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children?: ReactNode; search?: unknown }) => {
    calls.links.push(search);
    return createElement("a", null, children);
  },
  useRouteContext: () => ({
    access: {
      outlets: [
        { id: "00000000-0000-4000-8000-0000000000a1", name: "Outlet A" },
        { id: "00000000-0000-4000-8000-0000000000b2", name: "Outlet B" },
      ],
    },
  }),
}));

const pending = { isPending: true, isError: false, data: undefined };
vi.mock("@/features/ws05-payment-admin/hooks", () => ({
  useReconciliationSummary: (...args: unknown[]) => {
    calls.summary.push(args);
    return pending;
  },
  useReconciliationCases: (...args: unknown[]) => {
    calls.cases.push(args);
    return pending;
  },
  useResolveReconciliationCase: () => ({ isPending: false }),
  useSettlements: (...args: unknown[]) => {
    calls.settlements.push(args);
    return pending;
  },
}));

describe("C4b reconciliation panel scope", () => {
  it("keeps cases and summary tenant-wide; the outlet scopes settlements only", () => {
    renderToString(createElement(ReconciliationPanel));
    expect(calls.summary.length).toBeGreaterThan(0);
    for (const args of [...calls.summary, ...calls.cases])
      expect(args).toEqual([]);
    expect(calls.settlements.at(-1)).toEqual([
      "00000000-0000-4000-8000-0000000000a1",
    ]);
    expect(calls.links).toContainEqual({
      outletId: "00000000-0000-4000-8000-0000000000a1",
    });
  });
});
