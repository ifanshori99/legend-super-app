// legend-6xf7x (WS-05 FE): the guest pay dialog of the QR bill offers the
// methods the gateway reports, not a hard-coded list. Source of truth:
// docs/DECISIONS.md D24 + the `guestPaymentOptionSchema` contract
// (method, enabled, unavailableReason, banks) and the `guestPaymentSchema`
// (redirectUrl: hosted payment page or null).
//
// ASSUMPTIONS (spec does not fix these):
// - Method choices render as radio items (data-value = method code); the VA
//   bank picker also renders radio items whose value is the bank code.
// - Provider codes for the new methods follow D24: "ewallet" and "card".
// - A disabled method stays visible, shows a reason, and cannot be selected.
// - With no enabled method the guest cannot start a payment at all.
// - A redirectUrl is followed through window.location (assign/replace/href),
//   window.open or the router's navigate({ href }); a non-https url is never
//   followed (the error copy for it is not fixed, so it is not asserted).
// - No jsdom here: react-dom/server plus a tiny harness that keeps useState
//   across renders and exposes the dialog's click handlers.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { GuestPaymentTarget } from "@starter/shared/qr-order";
import {
  createTranslator,
  formatRupiah,
  messagesId,
} from "@starter/shared/i18n";

type Bank = { code: string; name: string };
type Option = {
  method: string;
  enabled: boolean;
  unavailableReason: string | null;
  banks: Bank[];
};

const h = vi.hoisted(() => ({
  options: undefined as unknown[] | undefined,
  result: null as unknown,
  fail: false,
  isError: false,
  pending: false,
  dialogOnOpenChange: undefined as ((open: boolean) => void) | undefined,
  mutate: null as unknown as (...args: unknown[]) => unknown,
  mutateAsync: null as unknown as (...args: unknown[]) => unknown,
  navigate: null as unknown as (...args: unknown[]) => unknown,
  slots: [] as unknown[],
  idx: 0,
  items: [] as {
    value: string;
    disabled: boolean;
    onValueChange?: (value: string) => void;
  }[],
  buttons: [] as {
    text: string;
    disabled: boolean;
    onClick?: () => void;
  }[],
}));

// One mounted dialog: useState survives between renderToString calls.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const i = h.idx++;
      if (!(i in h.slots))
        h.slots[i] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      return [
        h.slots[i],
        (next: unknown) => {
          h.slots[i] =
            typeof next === "function"
              ? (next as (prev: unknown) => unknown)(h.slots[i])
              : next;
        },
      ];
    },
  };
});

vi.mock("radix-ui", async (original) => {
  const lib = await original<typeof import("radix-ui")>();
  const react = await import("react");
  type Ctx = {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  };
  const Context = react.createContext<Ctx>({});
  const RadioGroup = {
    Root: (props: Record<string, unknown>) =>
      react.createElement(
        Context.Provider,
        {
          value: {
            value: props.value as string,
            onValueChange: props.onValueChange as (v: string) => void,
            disabled: props.disabled as boolean,
          },
        },
        react.createElement(
          "div",
          { role: "radiogroup", "aria-label": props["aria-label"] as string },
          props.children as never,
        ),
      ),
    Item: (props: Record<string, unknown>) => {
      const ctx = react.useContext(Context);
      const value = props.value as string;
      const disabled =
        props.disabled === true ||
        props["aria-disabled"] === true ||
        props["aria-disabled"] === "true" ||
        ctx.disabled === true;
      h.items.push({ value, disabled, onValueChange: ctx.onValueChange });
      return react.createElement(
        "button",
        {
          role: "radio",
          type: "button",
          "aria-checked": ctx.value === value,
          disabled,
          "data-value": value,
        },
        props.children as never,
      );
    },
    Indicator: (props: Record<string, unknown>) =>
      react.createElement("span", null, props.children as never),
  };
  return { ...lib, RadioGroup };
});

vi.mock("@/components/ui/dialog", async () => {
  const react = await import("react");
  const wrap =
    (tag: string) =>
    ({ children }: { children?: never }) =>
      react.createElement(tag, null, children);
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange?: (open: boolean) => void;
      children?: never;
    }) => {
      h.dialogOnOpenChange = onOpenChange;
      return open
        ? react.createElement("div", { role: "dialog" }, children)
        : null;
    },
    DialogContent: wrap("div"),
    DialogHeader: wrap("div"),
    DialogFooter: wrap("div"),
    DialogTitle: wrap("h2"),
    DialogDescription: wrap("p"),
    DialogTrigger: wrap("div"),
    DialogClose: wrap("div"),
  };
});

vi.mock("@/components/ui/button", async () => {
  const react = await import("react");
  const textOf = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(textOf).join("")
        : node && typeof node === "object" && "props" in node
          ? textOf((node as { props: { children?: unknown } }).props.children)
          : "";
  return {
    Button: (props: {
      children?: unknown;
      onClick?: () => void;
      disabled?: boolean;
      loading?: boolean;
    }) => {
      const disabled = props.disabled === true || props.loading === true;
      h.buttons.push({
        text: textOf(props.children),
        disabled,
        onClick: props.onClick,
      });
      return react.createElement(
        "button",
        { type: "button", disabled },
        props.children as never,
      );
    },
  };
});

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => h.navigate,
}));

// Not spread from the original: it pulls the API client (server-only globals).
vi.mock("@/features/ws03-qr-order/hooks", () => ({
  useGuestPaymentOptions: () => ({
    data: h.options ? { data: { methods: h.options } } : undefined,
    isPending: h.options === undefined,
    isError: false,
  }),
  useStartPayment: () => ({
    mutate: h.mutate,
    mutateAsync: h.mutateAsync,
    reset: () => {},
    isPending: h.pending,
    isError: h.isError,
    error: h.isError ? new Error("start failed") : null,
  }),
}));

import { PayDialog } from "@/features/ws03-qr-order/components/bill/pay-dialog";

const t = createTranslator(messagesId);
const target: GuestPaymentTarget = { kind: "bill" };
const BCA: Bank = { code: "BC", name: "BCA Virtual Account" };
const MANDIRI: Bank = { code: "M2", name: "Mandiri Virtual Account" };

const qris: Option = {
  method: "qris",
  enabled: true,
  unavailableReason: null,
  banks: [],
};
const va: Option = {
  method: "va",
  enabled: true,
  unavailableReason: null,
  banks: [BCA, MANDIRI],
};
const disabled = (method: string, reason: string): Option => ({
  method,
  enabled: false,
  unavailableReason: reason,
  banks: [],
});

const submitted: { input: Record<string, unknown> }[] = [];
const navigations: string[] = [];
const routerCalls: unknown[] = [];
let onOpenChange: ReturnType<typeof vi.fn>;

function render(open = true): string {
  h.idx = 0;
  h.items = [];
  h.buttons = [];
  return renderToString(
    createElement(PayDialog, {
      open,
      onOpenChange,
      qrToken: "table-token",
      sessionId: "session-1",
      target,
      amountIdr: 50_000,
    }),
  );
}

/** Method and bank radios as the guest sees them. */
function radios(html: string) {
  return [
    ...html.matchAll(/<button role="radio"([^>]*)>([\s\S]*?)<\/button>/g),
  ].map((match) => ({
    value: /data-value="([^"]*)"/.exec(match[1] ?? "")?.[1] ?? "",
    disabled: /\bdisabled\b/.test(match[1] ?? ""),
    text: (match[2] ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

function radio(html: string, value: string) {
  return radios(html).find((item) => item.value === value);
}

/** Guest taps a radio. Disabled radios do nothing, as in a browser. */
function choose(value: string): boolean {
  const item = h.items.find((entry) => entry.value === value);
  if (!item || item.disabled) return false;
  item.onValueChange?.(value);
  return true;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Guest taps the primary button; browser navigation is recorded. */
async function submit(): Promise<void> {
  const button = [...h.buttons]
    .reverse()
    .find((entry) => entry.text !== t("common.cancel"));
  if (!button || button.disabled) return;
  const location = {
    assign: (url: string) => navigations.push(String(url)),
    replace: (url: string) => navigations.push(String(url)),
  };
  Object.defineProperty(location, "href", {
    set: (url: string) => navigations.push(String(url)),
    get: () => "https://app.test/t/table-token/bill",
  });
  const fakeWindow = {
    location,
    open: (url: string) => {
      navigations.push(String(url));
      return null;
    },
  };
  const globals = globalThis as Record<string, unknown>;
  globals.window = fakeWindow;
  globals.location = location;
  try {
    button.onClick?.();
    await tick();
    await tick();
  } finally {
    delete globals.window;
    delete globals.location;
  }
}

function wentTo(url: string): boolean {
  return (
    navigations.includes(url) ||
    routerCalls.some((call) => JSON.stringify(call).includes(url))
  );
}

function payment(redirectUrl: string | null) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    target,
    method: "qris",
    amountIdr: 50_000,
    status: "pending",
    qrisPayload: redirectUrl === null ? "000201010212" : null,
    redirectUrl,
    vaNumber: null,
    bankCode: null,
    bankName: null,
    expiresAt: "2026-11-17T10:00:00.000Z",
    paidAt: null,
  };
}

beforeEach(() => {
  h.options = [qris, va];
  h.result = payment(null);
  h.fail = false;
  h.isError = false;
  h.pending = false;
  h.slots = [];
  submitted.length = 0;
  navigations.length = 0;
  routerCalls.length = 0;
  onOpenChange = vi.fn();
  h.navigate = (...args: unknown[]) => {
    routerCalls.push(args[0]);
    return Promise.resolve();
  };
  h.mutate = (...args: unknown[]) => {
    submitted.push({ input: args[0] as Record<string, unknown> });
    const options = args[1] as
      | { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }
      | undefined;
    if (h.fail) {
      h.isError = true;
      options?.onError?.(new Error("start failed"));
    } else options?.onSuccess?.({ data: h.result });
  };
  h.mutateAsync = (...args: unknown[]) => {
    submitted.push({ input: args[0] as Record<string, unknown> });
    if (h.fail) {
      h.isError = true;
      return Promise.reject(new Error("start failed"));
    }
    return Promise.resolve({ data: h.result });
  };
});

describe("ws03 pay dialog: methods come from the payment options", () => {
  test("lists exactly the methods the options hook returns", () => {
    h.options = [qris, va];
    const html = render();

    expect(radio(html, "qris")?.text).toMatch(/QRIS/i);
    expect(radio(html, "va")?.text).toMatch(/Virtual Account/i);
    expect(radio(html, "va")?.disabled).toBe(false);
  });

  test("a method the options omit is not offered", () => {
    h.options = [qris];
    const html = render();

    expect(radio(html, "qris")).toBeDefined();
    expect(radio(html, "va")).toBeUndefined();
    expect(html).not.toMatch(/Virtual Account/i);
  });

  test("e-wallet and card from the provider appear as choices", () => {
    h.options = [
      qris,
      {
        method: "ewallet",
        enabled: true,
        unavailableReason: null,
        banks: [],
      },
      { method: "card", enabled: true, unavailableReason: null, banks: [] },
    ];
    const html = render();

    expect(radio(html, "ewallet")?.text).toMatch(/e-?wallet/i);
    expect(radio(html, "card")?.text).toMatch(/kartu|card/i);
    expect(radio(html, "ewallet")?.disabled).toBe(false);
    expect(radio(html, "card")?.disabled).toBe(false);
  });

  test("an enabled e-wallet can be chosen and is sent as the method", async () => {
    h.options = [
      qris,
      {
        method: "ewallet",
        enabled: true,
        unavailableReason: null,
        banks: [],
      },
    ];
    render();
    expect(choose("ewallet")).toBe(true);
    render();
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.input).toMatchObject({ method: "ewallet", target });
  });

  test("QRIS is sent without a bank", async () => {
    render();
    expect(choose("qris")).toBe(true);
    render();
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.input).toMatchObject({ method: "qris", target });
    expect(submitted[0]?.input.bankCode ?? null).toBeNull();
  });
});

describe("ws03 pay dialog: unavailable methods", () => {
  test.each(["gateway_down", "routing_disabled", "no_channels"])(
    "a method off for %s is shown with a reason and cannot be chosen",
    async (reason) => {
      h.options = [qris, disabled("va", reason)];
      const html = render();
      const item = radio(html, "va");

      expect(item).toBeDefined();
      expect(item?.disabled).toBe(true);
      expect(item?.text).toMatch(/Virtual Account/i);
      // A visible reason beyond the bare method name (wording is not fixed).
      expect(
        item?.text.replace(/Virtual Account/i, "").trim().length,
      ).toBeGreaterThan(15);

      expect(choose("va")).toBe(false);
      render();
      await submit();
      expect(submitted.every((call) => call.input.method !== "va")).toBe(true);
    },
  );

  test("QRIS off: the guest cannot start a QRIS payment by default", async () => {
    h.options = [disabled("qris", "gateway_down"), va];
    const html = render();

    expect(radio(html, "qris")?.disabled).toBe(true);
    await submit();
    expect(submitted.every((call) => call.input.method !== "qris")).toBe(true);
  });

  test("every method off: nothing can be submitted", async () => {
    h.options = [
      disabled("qris", "gateway_down"),
      disabled("va", "gateway_down"),
    ];
    const html = render();

    expect(radios(html).every((item) => item.disabled)).toBe(true);
    await submit();
    expect(submitted).toHaveLength(0);
  });

  test("no methods at all (empty list): nothing to pick, nothing submitted", async () => {
    h.options = [];
    const html = render();

    expect(radios(html)).toHaveLength(0);
    expect(html).toMatch(
      /Belum ada cara bayar online yang tersedia\. Silakan bayar di kasir\./,
    );
    expect(html).not.toMatch(/Virtual Account sedang tidak tersedia/);
    await submit();
    expect(submitted).toHaveLength(0);
  });

  test("CTA names the method; with no method it never ends in a dangling 'dengan'", () => {
    h.options = [qris, va];
    expect(render()).toMatch(/Bayar[^<]*dengan QRIS/);

    // Every method off: the disabled CTA falls back to the plain label.
    h.options = [
      disabled("qris", "gateway_down"),
      disabled("va", "gateway_down"),
    ];
    const allOff = render();
    expect(allOff).toMatch(/Lanjut bayar/);
    expect(allOff).not.toMatch(/dengan\s*</);

    // Empty list: no pay button at all (only Tutup), so no dangling label either.
    h.options = [];
    expect(render()).not.toMatch(/dengan\s*</);
  });
});

describe("ws03 pay dialog: virtual account bank picker", () => {
  test("choosing VA shows the banks from the options", () => {
    render();
    expect(choose("va")).toBe(true);
    const html = render();

    expect(html).toContain(BCA.name);
    expect(html).toContain(MANDIRI.name);
  });

  test("a bank the options do not list is never offered", () => {
    h.options = [qris, { ...va, banks: [BCA] }];
    render();
    choose("va");
    const html = render();

    expect(html).toContain(BCA.name);
    expect(html).not.toContain(MANDIRI.name);
  });

  test("VA with the picked bank sends method va and that bank code", async () => {
    render();
    choose("va");
    render();
    expect(choose(MANDIRI.code)).toBe(true);
    render();
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.input).toMatchObject({
      method: "va",
      bankCode: MANDIRI.code,
      target,
    });
  });

  test("VA with several banks and none chosen asks to pick a bank first", () => {
    render();
    choose("va");
    const html = render();

    expect(html).toContain("Pilih bank dulu");
  });

  test("the bank hint is gone once a bank is chosen, and for QRIS", () => {
    expect(render()).not.toContain("Pilih bank dulu");
    choose("va");
    render();
    choose(BCA.code);
    expect(render()).not.toContain("Pilih bank dulu");
  });

  test("a VA is never started without a bank", async () => {
    render();
    choose("va");
    render();
    await submit();

    expect(
      submitted.every(
        (call) =>
          call.input.method !== "va" ||
          [BCA.code, MANDIRI.code].includes(String(call.input.bankCode)),
      ),
    ).toBe(true);
  });
});

describe("ws03 pay dialog: hosted payment page redirect", () => {
  test("an https redirectUrl sends the guest there", async () => {
    const url = "https://app.duitku.example/pay?ref=ABC123";
    h.result = payment(url);
    render();
    await submit();

    expect(submitted).toHaveLength(1);
    expect(wentTo(url)).toBe(true);
  });

  test.each([
    "http://app.duitku.example/pay?ref=ABC123",
    "javascript:alert(1)",
    "//evil.example/pay",
    "ftp://files.example/pay",
    "data:text/html,<script>alert(1)</script>",
  ])("a non-https redirectUrl %s is refused", async (url) => {
    h.result = payment(url);
    render();
    await submit();

    expect(wentTo(url)).toBe(false);
    expect(navigations).toHaveLength(0);
  });

  test("without a redirectUrl the guest goes to the in-app payment screen", async () => {
    h.result = payment(null);
    render();
    await submit();

    expect(navigations).toHaveLength(0);
    expect(routerCalls).toContainEqual(
      expect.objectContaining({
        to: "/t/$token/pay/$paymentId",
        params: {
          token: "table-token",
          paymentId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
  });

  test("a failed start shows the error and does not navigate", async () => {
    h.fail = true;
    render();
    await submit();
    const html = render();

    expect(html).toContain(t("qrOrders.bill.payFailed"));
    expect(navigations).toHaveLength(0);
    expect(routerCalls).toHaveLength(0);
  });
});

describe("ws03 pay dialog: reopen resets the form and the idempotency key", () => {
  const keyOf = (index: number) => submitted[index]?.input.idempotencyKey;

  test("a retry of the same request reuses its key", async () => {
    h.fail = true;
    render();
    await submit();
    render();
    await submit();

    expect(submitted).toHaveLength(2);
    expect(keyOf(0)).toEqual(expect.any(String));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  test("a changed method or bank after a failure gets a new key", async () => {
    h.fail = true;
    render();
    await submit();
    render();
    choose("va");
    render();
    choose(BCA.code);
    render();
    await submit();
    render();
    choose(MANDIRI.code);
    render();
    await submit();

    expect(submitted).toHaveLength(3);
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(keyOf(2)).not.toBe(keyOf(1));
  });

  test("opened again through the open prop: pick, bank, and key are fresh", async () => {
    h.fail = true;
    render();
    choose("va");
    render();
    choose(BCA.code);
    render();
    await submit();
    expect(submitted[0]?.input).toMatchObject({ method: "va", bankCode: "BC" });

    // The parent closes and reopens the dialog by the prop alone.
    render(false);
    render(true);
    render(true);
    await submit();

    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.input.method).toBe("qris");
    expect(submitted[1]?.input.bankCode ?? null).toBeNull();
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe("ws03 pay dialog: no closing while the start request runs", () => {
  test("Cancel is disabled and Escape or the backdrop do not close", () => {
    h.pending = true;
    render();
    const cancel = h.buttons.find((entry) => entry.text === t("common.cancel"));

    expect(cancel?.disabled).toBe(true);
    h.dialogOnOpenChange?.(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("while the request runs, the method rows cannot be changed", () => {
    h.options = [qris, va];
    h.pending = true;
    const html = render();

    expect(radios(html).length).toBeGreaterThan(0);
    expect(radios(html).every((item) => item.disabled)).toBe(true);
  });

  test("no methods: only Tutup, no dead pay button, no generic empty hint", () => {
    h.options = [];
    const html = render();
    const labels = h.buttons.map((entry) => entry.text);

    expect(labels).toContain(t("common.close"));
    expect(labels).not.toContain(t("common.cancel"));
    expect(labels).not.toContain(t("qrOrders.bill.payContinue"));
    expect(labels.some((text) => /^Bayar /.test(text))).toBe(false);
    expect(html).not.toMatch(/Data akan muncul di sini/);
  });

  test("with methods the pay button and Batal stay", () => {
    h.options = [qris, va];
    render();
    const labels = h.buttons.map((entry) => entry.text);

    expect(labels).toContain(t("common.cancel"));
    expect(labels.some((text) => /^Bayar /.test(text))).toBe(true);
  });

  test("when idle, Cancel and Escape close the dialog", () => {
    render();
    const cancel = h.buttons.find((entry) => entry.text === t("common.cancel"));

    expect(cancel?.disabled).toBe(false);
    h.dialogOnOpenChange?.(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ws03 pay dialog: presentation", () => {
  test("the pay button names the amount and the chosen method", () => {
    render();
    const pay = h.buttons.find((entry) => entry.text !== t("common.cancel"));

    expect(pay?.text).toBe(
      t("qrOrders.bill.payWith", {
        amount: formatRupiah(50_000),
        method: t("qrOrders.bill.methodQris"),
      }),
    );
    expect(pay?.text).not.toMatch(/\s{2,}/);
  });

  test("the pay button follows the picked method label from the catalog", () => {
    render();
    choose("va");
    render();
    const pay = h.buttons.find((entry) => entry.text !== t("common.cancel"));

    expect(pay?.text).toContain(`dengan ${t("payment.methodVa")}`);
    expect(pay?.text).toContain(formatRupiah(50_000));
  });

  test("an unavailable method keeps its reason at full contrast", () => {
    h.options = [qris, disabled("va", "gateway_down")];
    const html = render();

    expect(html).not.toMatch(/(?<![-\w])disabled:opacity-60/);
    expect(html).toContain("group-disabled:opacity-60");
    expect(html).toContain("text-muted-foreground");
  });

  test("the scroll area leaves room for focus rings", () => {
    expect(render()).toMatch(/class="[^"]*\boverflow-y-auto\b[^"]*\bpx-1\b/);
  });
});
