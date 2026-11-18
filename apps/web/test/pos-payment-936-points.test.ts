// Brief 936 part A (legend-5w6): cashier panel to redeem member points. The
// server converts points to rupiah and caps the amount: the panel shows the
// quote's valueIdr, never points x rate, and cannot double-send a redeem.
//
// Assumptions: usePointsAccount returns a react-query result (`data` is null
// for an order without a member); the quote is read from the quote mutation's
// `data`; the typed points are local state, seeded through a useState mock.
// Button labels follow the brief: "Hitung nilai", "Tukar poin", "Maks".
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
  account: {} as Record<string, unknown>,
  quote: {} as Record<string, unknown>,
  redeem: {} as Record<string, unknown>,
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
  usePointsAccount: () => state.account,
  useQuotePoints: () => state.quote,
  useRedeemPoints: () => state.redeem,
}));

import { PointsPanel } from "@/features/ws04-pos-kasir/components/payment/points-panel";

const ORDER = "01JCQ8Z5N0M3X4Y5Z6A7B8C9D0";

const account = {
  memberId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D1",
  memberName: "Sari Wulandari",
  balancePoints: 12_500,
  minRedeemPoints: 1_000,
  maxRedeemPoints: 9_800,
};

function query(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isLoading: false,
    isPending: false,
    isFetching: false,
    refetch: async () => undefined,
    ...over,
  };
}

function render() {
  return renderToString(
    createElement(PointsPanel, {
      orderId: ORDER,
      onDone: () => {},
      onCancel: () => {},
    }),
  );
}

beforeEach(() => {
  state.typed = "";
  state.account = query({ data: account });
  state.quote = mutation();
  state.redeem = mutation();
});

describe("points panel", () => {
  test("loading: says it is loading and offers no redeem", () => {
    state.account = query({ isLoading: true, isPending: true });
    const html = render();
    expect(buttonsOf(html).some((b) => /tukar poin/i.test(b.label))).toBe(
      false,
    );
  });

  test("order without a member: explains it, no redeem button", () => {
    state.account = query({ data: null });
    const html = render();
    const text = visibleText(html);
    expect(text).toMatch(/member/i);
    expect(html).not.toMatch(/<input\b/);
    expect(
      buttonsOf(html).some((b) => /^tukar poin$|hitung nilai/i.test(b.label)),
    ).toBe(false);
  });

  test("with member: shows name, balance and the server limits", () => {
    const html = render();
    const text = visibleText(html);
    expect(text).toContain("Sari Wulandari");
    expect(text).toMatch(/12\.500/);
    expect(text).toMatch(/1\.000/);
    expect(text).toMatch(/9\.800/);
    const labels = buttonsOf(html).map((b) => b.label);
    expect(labels).toContain("Maks");
    expect(labels.some((l) => /hitung nilai/i.test(l))).toBe(true);
  });

  test("quote: shows valueIdr from the server, not points x rate", () => {
    state.typed = "2500";
    // 1.875 differs from 2.500 points at any 1:1 rate the UI could assume.
    state.quote = mutation({ data: { points: 2_500, valueIdr: 1_875 } });
    const text = visibleText(render());
    expect(text).toContain(rupiah(1_875));
    expect(text).not.toContain(rupiah(2_500));
  });

  test("redeem pending: Tukar poin and Hitung nilai locked, busy shown", () => {
    state.typed = "2500";
    state.quote = mutation({ data: { points: 2_500, valueIdr: 1_875 } });
    state.redeem = mutation({ isPending: true });
    const actions = buttonsOf(render()).filter(
      (b) => !/batal|kembali|maks/i.test(b.label),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((b) => b.disabled)).toBe(true);
    expect(actions.some((b) => b.busy)).toBe(true);
  });

  test("no server quote yet: Tukar poin stays locked", () => {
    state.typed = "2500";
    const tukar = buttonsOf(render()).find((b) =>
      /^tukar poin$/i.test(b.label),
    );
    expect(tukar?.disabled).toBe(true);
  });

  test("server quote for the typed points unlocks Tukar poin", () => {
    state.typed = "2500";
    state.quote = mutation({ data: { points: 2_500, valueIdr: 1_875 } });
    const tukar = buttonsOf(render()).find((b) =>
      /^tukar poin$/i.test(b.label),
    );
    expect(tukar?.disabled).toBe(false);
  });

  test("quote pending: redeem cannot be sent meanwhile", () => {
    state.typed = "2500";
    state.quote = mutation({ isPending: true });
    const actions = buttonsOf(render()).filter(
      (b) => !/batal|kembali|maks/i.test(b.label),
    );
    expect(actions.every((b) => b.disabled)).toBe(true);
  });

  test("account error: a message and a way back", () => {
    state.account = query({ error: new Error("boom") });
    const html = render();
    expect(html).not.toContain("boom");
    expect(visibleText(html)).toMatch(/belum bisa|gagal/i);
    expect(buttonsOf(html).some((b) => /batal|kembali/i.test(b.label))).toBe(
      true,
    );
  });

  test("contract pending: says points are not connected yet", () => {
    state.account = query({
      error: Object.assign(new Error("pending"), { code: "CONTRACT_PENDING" }),
    });
    expect(visibleText(render())).toMatch(/belum tersambung/i);
  });
});
