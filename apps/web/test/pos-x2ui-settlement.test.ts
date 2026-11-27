// X2-UI (legend-wasr7.18): Tutup Hari shows, per EDC terminal, the receipts,
// what the bank file confirmed and the difference. Pinned from the brief and
// the X2 review (P3 7), not from the implementation:
//   1. Before any bank file matched a sale of the terminal, the screen says
//      "Menunggu file bank". It never shows Rp 0 as the bank figure, and it
//      shows no difference (nothing to compare yet).
//   2. After the file: receipt, bank and difference all come from the server
//      figures; a fully confirmed terminal has no difference.
//   3. A mismatch line (bank names the sale with another amount or terminal)
//      is a state of its own, never "waiting" and never "settled".
//   4. The "perlu dicek" count on the day check ignores terminals still waiting
//      for the bank file (review P3 7: too wide); null stays null.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createTranslator, formatRupiah } from "@starter/shared/i18n";
import {
  edcTerminalView,
  flaggedAfterBankFile,
  type EdcTerminalSettlement,
} from "@/features/ws04-pos-kasir/edc-settlement-view.ts";
import { EdcSettlementLines } from "@/features/ws04-pos-kasir/components/day-close/edc-settlement-lines.tsx";

const t = createTranslator();

const row = (over: Partial<EdcTerminalSettlement>): EdcTerminalSettlement => ({
  terminalId: "00000000-0000-4000-8000-000000000001",
  terminalCode: "EDC-01",
  bank: "bca",
  receiptIdr: 1_600_000,
  receiptCount: 4,
  settledIdr: 0,
  settledCount: 0,
  flaggedCount: 0,
  mismatchCount: 0,
  ...over,
});

describe("edcTerminalView", () => {
  it("waits for the bank file instead of showing Rp 0", () => {
    const view = edcTerminalView(row({ flaggedCount: 4 }));
    expect(view.state).toBe("waiting");
    expect(view.settledIdr).toBeNull();
    expect(view.differenceIdr).toBeNull();
    expect(view.receiptIdr).toBe(1_600_000);
  });

  it("settled: bank equals receipts, no difference", () => {
    const view = edcTerminalView(
      row({ settledIdr: 1_600_000, settledCount: 4 }),
    );
    expect(view).toMatchObject({
      state: "settled",
      settledIdr: 1_600_000,
      differenceIdr: 0,
    });
  });

  it("partial: some sales confirmed, the rest is the difference", () => {
    const view = edcTerminalView(
      row({ settledIdr: 1_000_000, settledCount: 2, flaggedCount: 2 }),
    );
    expect(view).toMatchObject({
      state: "partial",
      settledIdr: 1_000_000,
      differenceIdr: 600_000,
    });
  });

  it("mismatch is its own state even with nothing confirmed", () => {
    const view = edcTerminalView(row({ mismatchCount: 1, flaggedCount: 1 }));
    expect(view.state).toBe("mismatch");
    expect(view.settledIdr).toBe(0);
    expect(view.differenceIdr).toBe(1_600_000);
  });

  it("a terminal without receipts has nothing to wait for", () => {
    expect(edcTerminalView(row({ receiptIdr: 0, receiptCount: 0 })).state).toBe(
      "none",
    );
  });
});

describe("flaggedAfterBankFile", () => {
  it("counts only terminals the bank file has reached", () => {
    const rows = [
      row({ flaggedCount: 3 }), // waiting
      row({
        terminalId: "00000000-0000-4000-8000-000000000002",
        settledIdr: 800_000,
        settledCount: 2,
        flaggedCount: 1,
      }),
    ];
    expect(flaggedAfterBankFile(rows)).toBe(1);
  });

  it("null stays null (server has no EDC figures)", () => {
    expect(flaggedAfterBankFile(null)).toBeNull();
  });
});

describe("EdcSettlementLines", () => {
  const render = (settlement: EdcTerminalSettlement[] | null) =>
    renderToString(createElement(EdcSettlementLines, { settlement }));

  it("shows Menunggu file bank and no Rp 0 before the file", () => {
    const html = render([row({ flaggedCount: 4 })]);
    expect(html).toContain("Menunggu file bank");
    expect(html).toContain("EDC-01");
    expect(html).toContain(formatRupiah(1_600_000));
    expect(html).not.toContain(formatRupiah(0));
  });

  it("shows receipt, bank and difference after the file", () => {
    const html = render([
      row({ settledIdr: 1_000_000, settledCount: 2, flaggedCount: 2 }),
    ]);
    expect(html).not.toContain("Menunggu file bank");
    expect(html).toContain(t("posKasirDayclose.check.settlementReceipt"));
    expect(html).toContain(t("posKasirDayclose.check.settlementBankLabel"));
    expect(html).toContain(t("posKasirDayclose.check.settlementDifference"));
    for (const amount of [1_600_000, 1_000_000, 600_000])
      expect(html).toContain(formatRupiah(amount));
  });

  it("keeps the pending and none texts", () => {
    expect(render(null)).toContain(
      t("posKasirDayclose.check.settlementPending"),
    );
    expect(render([])).toContain(t("posKasirDayclose.check.settlementNone"));
  });
});
