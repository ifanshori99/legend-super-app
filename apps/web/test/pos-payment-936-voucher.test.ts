// Brief 936 part B (legend-5w6): cashier voucher panel. The server prices the
// discount: the panel shows discountPreviewIdr from the hook result, never a
// figure of its own, and the apply button cannot double-send while pending.
//
// Assumptions: the panel reads the check result from the validate mutation's
// `data`; the typed code is local state, seeded here through a useState mock
// (server rendering cannot type). Button labels follow the brief: "Cek",
// "Pakai voucher". Reason texts are matched by meaning, not exact wording.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  buttonsOf,
  mutation,
  rupiah,
  visibleText,
} from "./pos-payment-936-helpers";

const state = vi.hoisted(() => ({
  typed: "",
  validate: {} as Record<string, unknown>,
  apply: {} as Record<string, unknown>,
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(
        initial === "" && state.typed !== "" ? state.typed : initial,
      ),
  };
});

vi.mock("@/features/ws04-pos-kasir/hooks", () => ({
  CONTRACT_PENDING: "CONTRACT_PENDING",
  isContractPending: (error: unknown) =>
    (error as { code?: string } | null)?.code === "CONTRACT_PENDING",
  useValidateVoucher: () => state.validate,
  useApplyVoucher: () => state.apply,
  useRemoveVoucher: () => mutation(),
}));

import { VoucherPanel } from "@/features/ws04-pos-kasir/components/payment/voucher-panel";

const ORDER = "01JCQ8Z5N0M3X4Y5Z6A7B8C9D0";

function render() {
  return renderToString(
    createElement(VoucherPanel, {
      orderId: ORDER,
      onDone: () => {},
      onCancel: () => {},
    }),
  );
}

beforeEach(() => {
  state.typed = "";
  state.validate = mutation();
  state.apply = mutation();
});

describe("voucher panel", () => {
  test("empty: a code field, the Cek button and a scan hint", () => {
    const html = render();
    const text = visibleText(html);
    expect(text).toContain("Voucher");
    expect(html).toMatch(/<input\b/);
    expect(buttonsOf(html).some((b) => b.label === "Cek")).toBe(true);
    // Keyboard scanners type the code and press Enter: the user is told.
    expect(text).toMatch(/scan/i);
    // Nothing is claimed before a check.
    expect(text).not.toMatch(/voucher berlaku/i);
  });

  test("valid: shows the server preview discount, not a UI figure", () => {
    state.typed = "HEMAT20";
    // 27.300 is deliberately not a round 20% of any demo bill: if the UI
    // computed its own discount it could not produce this number.
    state.validate = mutation({
      data: { valid: true, code: "HEMAT20", discountPreviewIdr: 27_300 },
    });
    const html = render();
    const text = visibleText(html);
    expect(text).toContain(rupiah(27_300));
    expect(text).toMatch(/perkiraan/i);
    expect(text).toMatch(/server/i);
    const apply = buttonsOf(html).find((b) => /pakai voucher/i.test(b.label));
    expect(apply?.disabled).toBe(false);
  });

  test("invalid: shows a reason message and keeps Pakai voucher locked", () => {
    state.typed = "EXPIRED1";
    state.validate = mutation({
      data: { valid: false, code: "EXPIRED1", reason: "expired" },
    });
    const html = render();
    const text = visibleText(html);
    expect(text).toMatch(/kedaluwarsa/i);
    expect(text).not.toMatch(/Potongan\s+Rp/);
    const apply = buttonsOf(html).find((b) => /pakai voucher/i.test(b.label));
    expect(apply?.disabled).toBe(true);
  });

  test.each([
    ["not_found", /tidak ditemukan/i],
    ["already_redeemed", /sudah dipakai/i],
    ["min_spend_not_met", /minimum/i],
  ] as const)("invalid reason %s gets its own message", (reason, pattern) => {
    state.typed = "ABC123";
    state.validate = mutation({
      data: { valid: false, code: "ABC123", reason },
    });
    expect(visibleText(render())).toMatch(pattern);
  });

  test("apply pending: every action but cancel is locked and busy", () => {
    state.typed = "HEMAT20";
    state.validate = mutation({
      data: { valid: true, code: "HEMAT20", discountPreviewIdr: 27_300 },
    });
    state.apply = mutation({ isPending: true });
    const buttons = buttonsOf(render());
    const actions = buttons.filter((b) => !/batal|kembali/i.test(b.label));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((b) => b.disabled)).toBe(true);
    expect(actions.some((b) => b.busy)).toBe(true);
  });

  test("check pending: Cek is locked so a code is not sent twice", () => {
    state.typed = "HEMAT20";
    state.validate = mutation({ isPending: true });
    const actions = buttonsOf(render()).filter(
      (b) => !/batal|kembali/i.test(b.label),
    );
    expect(actions.every((b) => b.disabled)).toBe(true);
  });

  test("check error: the cashier sees a message, not a valid voucher", () => {
    state.typed = "HEMAT20";
    state.validate = mutation({ error: new Error("network down") });
    const text = visibleText(render());
    expect(text).toMatch(/belum bisa dicek|gagal|coba lagi/i);
    expect(text).not.toMatch(/voucher berlaku/i);
  });

  test("contract pending: says the voucher is not connected yet", () => {
    state.typed = "HEMAT20";
    state.validate = mutation({
      error: Object.assign(new Error("pending"), { code: "CONTRACT_PENDING" }),
    });
    expect(visibleText(render())).toMatch(/belum tersambung/i);
  });
});
