// Bead legend-mp44v, contract docs/briefs/sub-302-design.md D12-D14.
// Routing panel (server-rendered, no browser):
//   - each method row offers a backup ("Cadangan") choice built from the
//     providers that are enabled, never the row's own main provider, plus
//     "Tanpa cadangan";
//   - without org.settings.manage the change controls are disabled (the API
//     refuses the write, so the UI must not invite it).
//
// Assumptions: the panel reads the visitor's permissions the way EdcPanel does
// (route context `access`, an AreaAccess). Radix Select does not render its
// items while closed, so the Select primitive is replaced by a flat stand-in
// that lists every item and marks the trigger disabled when the Select is.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type {
  PaymentRoutingView,
  PaymentRoute,
} from "@starter/shared/payment/admin";
import { createTranslator, messagesId } from "@starter/shared/i18n";

const state = vi.hoisted(() => ({
  view: null as unknown,
  permissions: [] as string[],
  pending: false,
  error: false,
}));

vi.mock("@/features/ws05-payment-admin/hooks", () => {
  const result = () => ({
    data: state.pending || state.error ? undefined : { data: state.view },
    isPending: state.pending,
    isError: state.error,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
  return {
    usePaymentRouting: result,
    useUpdatePaymentRoute: () => ({ isPending: false, mutate: vi.fn() }),
  };
});

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

vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));

vi.mock("@/components/ui/select", async (original) => {
  const actual = await original<typeof import("@/components/ui/select")>();
  const { createElement, createContext, useContext } = await import("react");
  const Disabled = createContext(false);
  return {
    ...actual,
    Select: (props: {
      value?: string;
      disabled?: boolean;
      children?: React.ReactNode;
    }) =>
      createElement(
        Disabled.Provider,
        { value: Boolean(props.disabled) },
        createElement(
          "div",
          { "data-select": "", "data-value": props.value },
          props.children,
        ),
      ),
    SelectTrigger: (props: {
      disabled?: boolean;
      children?: React.ReactNode;
      "aria-label"?: string;
    }) => {
      const parentDisabled = useContext(Disabled);
      return createElement(
        "button",
        {
          type: "button",
          "aria-label": props["aria-label"],
          disabled: parentDisabled || Boolean(props.disabled),
        },
        props.children,
      );
    },
    SelectValue: () => null,
    SelectContent: (props: { children?: React.ReactNode }) =>
      createElement("div", null, props.children),
    SelectItem: (props: {
      value: string;
      disabled?: boolean;
      children?: React.ReactNode;
    }) =>
      createElement(
        "span",
        {
          "data-item": props.value,
          ...(props.disabled ? { "data-disabled": "" } : {}),
        },
        props.children,
      ),
  };
});

import { RoutingPanel } from "@/features/ws05-payment-admin/components/routing-panel";

const t = createTranslator(messagesId);
const TENANT = "00000000-0000-4000-8000-000000000001";

function route(
  n: number,
  method: PaymentRoute["method"],
  provider: string,
  fallbackProvider: string | null,
): PaymentRoute {
  return {
    id: `00000000-0000-4000-8000-00000000010${n}`,
    tenantId: TENANT,
    outletId: null,
    method,
    provider,
    fallbackProvider,
    enabled: true,
    updatedAt: "2026-11-16T00:00:00.000Z",
  } as PaymentRoute;
}

beforeEach(() => {
  const view: PaymentRoutingView = {
    scope: "tenant",
    outletId: null,
    outletName: null,
    outlets: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Outlet A" }],
    providers: [
      { code: "doit", name: "DOIT Gateway", kind: "gateway", enabled: true },
      { code: "midtrans", name: "Midtrans", kind: "gateway", enabled: true },
      { code: "xendit", name: "Xendit Mati", kind: "gateway", enabled: false },
    ],
    routes: [
      route(1, "qris", "doit", null),
      route(2, "va", "midtrans", "doit"),
    ],
  };
  state.view = view;
  state.permissions = ["org.settings.manage"];
  state.pending = false;
  state.error = false;
});

function rows(html: string): string[] {
  return html.split("<li").slice(1);
}

// The switch is a Radix button; class names contain "disabled:" variants, so
// drop the class attribute before looking for the disabled attribute.
function switchDisabled(row: string): boolean {
  const tag = row.match(/<button[^>]*role="switch"[^>]*>/);
  expect(tag, "switch in row").not.toBeNull();
  const attrs = (tag as RegExpMatchArray)[0].replace(/\sclass="[^"]*"/g, "");
  return /\sdisabled(=|\s|>)/.test(attrs);
}

function selectOf(row: string, label: string) {
  const parts = row.split("data-select").slice(1);
  const part = parts.find((chunk) => chunk.includes(`aria-label="${label}"`));
  expect(part, `select "${label}" in row`).toBeDefined();
  const body = part as string;
  return {
    disabled: /<button[^>]*aria-label="[^"]*"[^>]*disabled/.test(body),
    options: [...body.matchAll(/data-item="([^"]*)"[^>]*>([^<]*)</g)].map(
      (m) => ({ value: m[1], label: m[2] }),
    ),
  };
}

describe("ws05 routing panel: backup provider choices", () => {
  test("backup lists enabled providers except the main one, plus Tanpa cadangan", () => {
    const html = renderToString(createElement(RoutingPanel));
    const [qris, va] = rows(html);
    const fallbackLabel = t("paymentAdmin.routing.fallback");

    const qrisFallback = selectOf(qris, fallbackLabel);
    expect(qrisFallback.options.map((o) => o.label)).toEqual([
      t("paymentAdmin.routing.noFallback"),
      "Midtrans",
    ]);

    const vaFallback = selectOf(va, fallbackLabel);
    expect(vaFallback.options.map((o) => o.label)).toEqual([
      t("paymentAdmin.routing.noFallback"),
      "DOIT Gateway",
    ]);
  });

  test("a disabled provider is never offered as main or backup", () => {
    const html = renderToString(createElement(RoutingPanel));
    expect(html).not.toContain("Xendit Mati");
    for (const row of rows(html)) {
      const main = selectOf(row, t("paymentAdmin.routing.provider"));
      expect(main.options.map((o) => o.label)).toEqual([
        "DOIT Gateway",
        "Midtrans",
      ]);
    }
  });

  test("the main provider is not offered as its own backup", () => {
    const html = renderToString(createElement(RoutingPanel));
    const [qris, va] = rows(html);
    const fallbackLabel = t("paymentAdmin.routing.fallback");
    expect(
      selectOf(qris, fallbackLabel).options.map((o) => o.label),
    ).not.toContain("DOIT Gateway");
    expect(
      selectOf(va, fallbackLabel).options.map((o) => o.label),
    ).not.toContain("Midtrans");
  });
});

describe("ws05 routing panel: org.settings.manage gates the controls", () => {
  const controlLabels = () => [
    t("paymentAdmin.routing.provider"),
    t("paymentAdmin.routing.fallback"),
  ];

  test("without org.settings.manage the select controls are disabled", () => {
    state.permissions = ["payment.edc.manage", "payment.transaction.view"];
    const html = renderToString(createElement(RoutingPanel));
    for (const row of rows(html)) {
      for (const label of controlLabels())
        expect(selectOf(row, label).disabled, label).toBe(true);
    }
  });

  test("without org.settings.manage the enabled switch is disabled", () => {
    state.permissions = ["payment.edc.manage"];
    const html = renderToString(createElement(RoutingPanel));
    for (const row of rows(html)) {
      expect(switchDisabled(row)).toBe(true);
    }
  });

  test("with org.settings.manage the controls are editable", () => {
    state.permissions = ["org.settings.manage"];
    const html = renderToString(createElement(RoutingPanel));
    for (const row of rows(html)) {
      for (const label of controlLabels())
        expect(selectOf(row, label).disabled, label).toBe(false);
      expect(switchDisabled(row)).toBe(false);
    }
  });
});

describe("ws05 routing panel: loading and error keep the scope selector", () => {
  test("pending shows the scope selector, a busy skeleton and no rows", () => {
    state.pending = true;
    const html = renderToString(createElement(RoutingPanel));
    expect(html).toContain(t("paymentAdmin.routing.scope"));
    expect(html).toContain(t("paymentAdmin.routing.scopeTenant"));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(t("common.loading"));
    expect(rows(html)).toHaveLength(0);
  });

  test("the skeleton mirrors the list: header bar, desktop rows, phone blocks", () => {
    state.pending = true;
    const html = renderToString(createElement(RoutingPanel));
    expect(html).toContain("sr-only");
    // One header bar and three method rows, each with a phone block.
    expect(html.match(/hidden h-12 lg:block/g)).toHaveLength(1);
    expect(html.match(/h-62 lg:hidden/g)).toHaveLength(3);
    expect(html.match(/hidden gap-3[^"]*lg:grid/g)).toHaveLength(3);
    expect(html).toContain("lg:grid-cols-[minmax(12rem,1fr)");
  });

  test("an error shows the scope selector and the retry state", () => {
    state.error = true;
    const html = renderToString(createElement(RoutingPanel));
    expect(html).toContain(t("paymentAdmin.routing.scope"));
    expect(html).toContain(t("paymentAdmin.loadErrorTitle"));
    expect(rows(html)).toHaveLength(0);
  });

  test("the outlet scope is disabled until the outlet list is ready", () => {
    const outletRadio = (html: string) => {
      const tag = html.match(/<button[^>]*value="outlet"[^>]*>/);
      expect(tag, "outlet radio").not.toBeNull();
      return (tag as RegExpMatchArray)[0].replace(/\sclass="[^"]*"/g, "");
    };
    state.pending = true;
    expect(outletRadio(renderToString(createElement(RoutingPanel)))).toMatch(
      /\sdisabled(=|\s|>)/,
    );
    state.pending = false;
    (state.view as PaymentRoutingView).outlets = [];
    expect(outletRadio(renderToString(createElement(RoutingPanel)))).toMatch(
      /\sdisabled(=|\s|>)/,
    );
  });

  test("with outlets the outlet scope is selectable", () => {
    const html = renderToString(createElement(RoutingPanel));
    const tag = (
      html.match(/<button[^>]*value="outlet"[^>]*>/) as RegExpMatchArray
    )[0].replace(/\sclass="[^"]*"/g, "");
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});

describe("ws05 routing panel: row details", () => {
  test("each enabled switch names its own method", () => {
    const html = renderToString(createElement(RoutingPanel));
    const labels = [...html.matchAll(/role="switch"[^>]*aria-label="([^"]*)"/g)]
      .map((m) => m[1])
      .concat(
        [...html.matchAll(/aria-label="([^"]*)"[^>]*role="switch"/g)].map(
          (m) => m[1],
        ),
      );
    expect(new Set(labels)).toEqual(
      new Set([
        t("paymentAdmin.routing.enableMethod", {
          method: t("paymentAdmin.method.qris"),
        }),
        t("paymentAdmin.routing.enableMethod", {
          method: t("paymentAdmin.method.va"),
        }),
      ]),
    );
  });

  test("a saved gateway that is switched off stays visible as a disabled item", () => {
    (state.view as PaymentRoutingView).routes = [
      route(1, "qris", "xendit", "doit"),
    ];
    const html = renderToString(createElement(RoutingPanel));
    const [row] = rows(html);
    const main = selectOf(row, t("paymentAdmin.routing.provider"));
    expect(main.options.map((o) => o.label)).toContain(
      t("paymentAdmin.routing.inactiveProvider", { name: "Xendit Mati" }),
    );
    expect(row).toMatch(/data-item="xendit"[^>]*data-disabled/);
  });

  test("the backup field is optional and the save button has a fixed width", () => {
    const html = renderToString(createElement(RoutingPanel));
    const [row] = rows(html);
    expect(row).not.toContain("lucide-check");
    const save = row.match(/<button[^>]*>(?:(?!<\/button>).)*Simpan/s);
    expect(save?.[0]).toContain("w-20");
  });
});

describe("ws05 routing panel: empty state action", () => {
  beforeEach(() => {
    (state.view as PaymentRoutingView).routes = [];
  });

  test("offers the Duitku credentials step when the tab can be opened", () => {
    const html = renderToString(
      createElement(RoutingPanel, { onOpenTab: vi.fn() }),
    );
    expect(html).toContain(t("paymentAdmin.routing.emptyTitle"));
    expect(html).toContain(t("paymentAdmin.routing.emptyAction"));
    expect(t("paymentAdmin.routing.emptyAction")).toBe(
      "Buka kredensial Duitku",
    );
  });

  test("no action without the callback (Duitku tab hidden)", () => {
    const html = renderToString(createElement(RoutingPanel));
    expect(html).toContain(t("paymentAdmin.routing.emptyTitle"));
    expect(html).not.toContain(t("paymentAdmin.routing.emptyAction"));
  });
});

describe("ws05 routing panel: why Simpan is off", () => {
  const saveButton = (row: string) =>
    (
      row.match(/<button[^>]*>(?:(?!<\/button>).)*Simpan/s) as RegExpMatchArray
    )[0];

  test("an unchanged row explains it and the button points to the hint", () => {
    const [row] = rows(renderToString(createElement(RoutingPanel)));
    const hint = t("paymentAdmin.routing.saveHint");
    expect(hint).toBe("Ubah gateway untuk menyimpan");
    expect(row).toContain(hint);
    const id = /aria-describedby="([^"]+)"/.exec(saveButton(row))?.[1];
    expect(id, "aria-describedby on Simpan").toBeDefined();
    expect(row).toMatch(new RegExp(`<p id="${id}"[^>]*>${hint}</p>`));
  });

  test("without org.settings.manage there is no hint", () => {
    state.permissions = ["payment.edc.manage"];
    const [row] = rows(renderToString(createElement(RoutingPanel)));
    expect(row).not.toContain(t("paymentAdmin.routing.saveHint"));
    expect(saveButton(row)).not.toContain("aria-describedby");
  });
});
