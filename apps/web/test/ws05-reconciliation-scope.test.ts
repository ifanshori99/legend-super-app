// C4b review P3-3 (legend-osqou.8): the reconciliation panel's open cases and
// summary stay tenant-wide (no outletId, the API checks payment.reconcile at
// tenant level), so a difference at another outlet is never hidden. The outlet
// picker scopes the settlement list only, defaulting to the first outlet. The
// import link carries that outlet (UI audit P2-5).
//
// An outlet-only reconciler (tenant-wide reads answer 403) gets the selected
// outlet's cases and summary instead of a load error, with a short note.
//
// Server-rendered, no browser: the data hooks are stubbed and record their
// arguments.
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ApiError } from "@/lib/api/errors";
import { ReconciliationPanel } from "@/features/ws05-payment-admin/components/reconciliation-panel";

const calls = vi.hoisted(() => ({
  forbidTenant: false,
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
// Tenant-wide (no outletId) answers 403 for an outlet-only reconciler.
const answer = (args: unknown[]) =>
  calls.forbidTenant && args[0] === undefined
    ? {
        isPending: false,
        isError: true,
        data: undefined,
        error: new ApiError(403, "FORBIDDEN", "x"),
        refetch: () => undefined,
      }
    : pending;
vi.mock("@/features/ws05-payment-admin/hooks", () => ({
  useReconciliationSummary: (...args: unknown[]) => {
    calls.summary.push(args);
    return answer(args);
  },
  useReconciliationCases: (...args: unknown[]) => {
    calls.cases.push(args);
    return answer(args);
  },
  useResolveReconciliationCase: () => ({ isPending: false }),
  useSettlements: (...args: unknown[]) => {
    calls.settlements.push(args);
    return pending;
  },
}));

const OUTLET_A = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  calls.forbidTenant = false;
  calls.summary.length = 0;
  calls.cases.length = 0;
  calls.settlements.length = 0;
  calls.links.length = 0;
});

describe("C4b reconciliation panel scope", () => {
  it("keeps cases and summary tenant-wide; the outlet scopes settlements only", () => {
    renderToString(createElement(ReconciliationPanel));
    expect(calls.summary.length).toBeGreaterThan(0);
    for (const args of [...calls.summary, ...calls.cases])
      expect(args).toEqual([undefined]);
    expect(calls.settlements.at(-1)).toEqual([
      "00000000-0000-4000-8000-0000000000a1",
    ]);
    expect(calls.links).toContainEqual({
      outletId: "00000000-0000-4000-8000-0000000000a1",
    });
  });

  it("falls back to the selected outlet when tenant-wide reads are refused", () => {
    calls.forbidTenant = true;
    const html = renderToString(createElement(ReconciliationPanel));
    expect(calls.summary.at(-1)).toEqual([OUTLET_A]);
    expect(calls.cases.at(-1)).toEqual([OUTLET_A]);
    expect(html).toContain("Menampilkan outlet terpilih");
    expect(html).not.toContain("Data pembayaran tidak dapat dimuat");
  });
});
