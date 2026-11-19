// Bead legend-mp44v: the payment back office tabs live in the URL (?tab=) and
// the tab strip hints at horizontal scroll on a phone.
//   - the active tab follows the `tab` prop (the route passes ?tab=);
//   - an unknown id, or a tab the permissions hide, falls to the first visible
//     tab; with no visible tab nothing is selected;
//   - the route accepts only known tab ids and drops the rest;
//   - the strip carries two aria-hidden edge fades and the Duitku label is short.
//
// Server-rendered, no browser: panels are stubbed (each loads its own data).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  PAYMENT_ADMIN_TABS,
  type PaymentAdminTab,
} from "@/features/ws05-payment-admin/lib";
import {
  PaymentAdminPage,
  resolvePaymentAdminTab,
} from "@/features/ws05-payment-admin/components/payment-admin-page";
import { createTranslator, messagesId } from "@starter/shared/i18n";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  routingProps: null as { onOpenTab?: unknown } | null,
  holdsEnabled: null as boolean | null,
}));

vi.mock("@tanstack/react-router", async (original) => {
  const real = await original<typeof import("@tanstack/react-router")>();
  return {
    ...real,
    useRouteContext: () => ({
      access: {
        authenticated: true,
        permissions: state.permissions,
        mfaRequired: false,
        mfaVerified: true,
        stations: [],
        outlets: [],
      },
    }),
  };
});

vi.mock(
  "@/features/ws05-payment-admin/components/duitku-credentials-panel",
  () => ({
    DuitkuCredentialsPanel: () => null,
  }),
);
vi.mock("@/features/ws05-payment-admin/components/edc-panel", () => ({
  EdcPanel: () => null,
}));
vi.mock(
  "@/features/ws05-payment-admin/components/reconciliation-panel",
  () => ({
    ReconciliationPanel: () => null,
  }),
);
vi.mock("@/features/ws05-payment-admin/components/refund-holds-panel", () => ({
  RefundHoldsPanel: () => null,
}));
// The tab badge reads the open holds; the enabled flag is what the page owes.
vi.mock("@/features/ws05-payment-admin/hooks", () => ({
  useRefundReconHolds: (_status: string, enabled = true) => {
    state.holdsEnabled = enabled;
    return { data: undefined };
  },
}));
vi.mock("@/features/ws05-payment-admin/components/refunds-panel", () => ({
  RefundsPanel: () => null,
}));
vi.mock("@/features/ws05-payment-admin/components/routing-panel", () => ({
  RoutingPanel: (props: { onOpenTab?: unknown }) => {
    state.routingProps = props;
    return null;
  },
}));
vi.mock("@/features/ws05-payment-admin/components/unallocated-panel", () => ({
  UnallocatedPanel: () => null,
}));

const ALL = [
  "org.settings.manage",
  "org.integration.manage",
  "payment.edc.manage",
  "payment.transaction.view",
  "payment.reconcile",
];

function selectedTabs(html: string): string[] {
  return [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('aria-selected="true"'))
    .map((tag) => /id="[^"]*-trigger-([a-z-]+)"/.exec(tag)?.[1] ?? "?");
}

function render(
  permissions: string[],
  tab?: string,
  onTabChange?: (tab: PaymentAdminTab) => void,
): string {
  state.permissions = permissions;
  state.routingProps = null;
  state.holdsEnabled = null;
  return renderToString(createElement(PaymentAdminPage, { tab, onTabChange }));
}

describe("ws05 payment tabs: synced to the URL", () => {
  test("resolvePaymentAdminTab keeps a visible requested tab", () => {
    expect(resolvePaymentAdminTab("edc", ["routing", "edc"])).toBe("edc");
  });

  test("resolvePaymentAdminTab falls back to the first visible tab", () => {
    expect(resolvePaymentAdminTab(undefined, ["edc", "refunds"])).toBe("edc");
    expect(resolvePaymentAdminTab("nonsense", ["edc", "refunds"])).toBe("edc");
    // Known tab id, but this account may not see it.
    expect(resolvePaymentAdminTab("routing", ["edc", "refunds"])).toBe("edc");
    expect(resolvePaymentAdminTab("routing", [])).toBeUndefined();
  });

  test("the requested tab is the selected one", () => {
    expect(selectedTabs(render(ALL, "refunds"))).toEqual(["refunds"]);
    expect(selectedTabs(render(ALL, "reconciliation"))).toEqual([
      "reconciliation",
    ]);
  });

  test("no tab, or an unknown tab, selects the first visible tab", () => {
    expect(selectedTabs(render(ALL))).toEqual(["routing"]);
    expect(selectedTabs(render(ALL, "nonsense"))).toEqual(["routing"]);
    expect(selectedTabs(render(["payment.reconcile"]))).toEqual([
      "unallocated",
    ]);
  });

  test("the refund-holds badge query runs only for payment.reconcile", () => {
    render(["payment.transaction.view"]);
    expect(state.holdsEnabled).toBe(false);
    render(["payment.reconcile"]);
    expect(state.holdsEnabled).toBe(true);
    expect(selectedTabs(render(ALL, "refund-holds"))).toEqual([
      "refund-holds",
    ]);
  });

  test("a hidden tab is not selectable through the URL", () => {
    const html = render(["payment.transaction.view"], "routing");
    expect(selectedTabs(html)).toEqual(["refunds"]);
    expect(html).not.toContain("trigger-routing");
  });

  test("every tab id the page can show is accepted by the route search", () => {
    const route = readFileSync(
      new URL("../src/routes/_kelola/kelola.pembayaran.tsx", import.meta.url),
      "utf8",
    );
    for (const { tab } of PAYMENT_ADMIN_TABS) {
      expect(route).toContain(`"${tab}"`);
    }
    expect(route).toMatch(/validateSearch/);
    expect(route).toMatch(/\.catch\(undefined\)/);
  });
});

describe("ws05 payment tabs: phone strip", () => {
  test("two aria-hidden edge fades sit next to the tab list", () => {
    const html = render(ALL);
    const fades = html.match(
      /<div aria-hidden="true"[^>]*pointer-events-none/g,
    );
    expect(fades).toHaveLength(2);
  });

  test("the Duitku tab label is short", () => {
    const t = createTranslator(messagesId);
    expect(t("paymentAdmin.tabs.duitku")).toBe("Duitku");
    expect(render(ALL)).toContain("Duitku");
  });
});

describe("ws05 payment tabs: routing empty-state shortcut", () => {
  test("the routing panel gets the tab callback only when Duitku is visible", () => {
    const onTabChange = vi.fn();
    render(ALL, "routing", onTabChange);
    expect(state.routingProps?.onOpenTab).toBe(onTabChange);

    render(["org.settings.manage"], "routing", onTabChange);
    expect(state.routingProps).not.toBeNull();
    expect(state.routingProps?.onOpenTab).toBeUndefined();
  });
});
