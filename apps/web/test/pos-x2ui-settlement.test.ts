// X2-UI (legend-wasr7.18): Tutup Hari shows, per EDC terminal, the receipts,
// what the bank file confirmed and the difference. Pinned from the brief and
// the X2 review (P3 7), not from the implementation:
//   1. While the server says bankStatus "awaiting", the screen says "Menunggu
//      file bank". It never shows Rp 0 as the bank figure and shows no
//      difference (nothing to compare yet).
//   2. After the file: receipt, bank and difference are the server's figures
//      (differenceIdr from the server; the screen never subtracts money).
//   3. Mismatch and no_match (file in, none of the terminal's sales hit) are
//      states of their own, never "waiting" and never "settled".
//   4. The "perlu dicek" count on the day check ignores terminals still waiting
//      for the bank file (review P3 7: too wide); null stays null.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createTranslator, formatRupiah } from "@starter/shared/i18n";
import {
  edcNoticeTone,
  edcTerminalView,
  flaggedAfterBankFile,
  type EdcTerminalSettlement,
} from "@/features/ws04-pos-kasir/edc-settlement-view.ts";
import {
  EdcSettlementLines,
  EdcUnmatchedNote,
} from "@/features/ws04-pos-kasir/components/day-close/edc-settlement-lines.tsx";

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
  differenceIdr: 1_600_000,
  bankStatus: "awaiting",
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

  it("settled: the bank confirmed everything, server difference is 0", () => {
    const view = edcTerminalView(
      row({
        settledIdr: 1_600_000,
        settledCount: 4,
        differenceIdr: 0,
        bankStatus: "matched",
      }),
    );
    expect(view).toMatchObject({
      state: "settled",
      settledIdr: 1_600_000,
      differenceIdr: 0,
    });
  });

  it("partial: some sales confirmed, the server difference is the rest", () => {
    const view = edcTerminalView(
      row({
        settledIdr: 1_000_000,
        settledCount: 2,
        flaggedCount: 2,
        differenceIdr: 600_000,
        bankStatus: "matched",
      }),
    );
    expect(view).toMatchObject({
      state: "partial",
      settledIdr: 1_000_000,
      differenceIdr: 600_000,
    });
  });

  it("shows the server difference as given, not receipts minus bank", () => {
    // A figure the screen could not derive: proves it is passed through.
    const view = edcTerminalView(
      row({
        settledIdr: 1_000_000,
        settledCount: 2,
        differenceIdr: 123,
        bankStatus: "matched",
      }),
    );
    expect(view.differenceIdr).toBe(123);
  });

  it("mismatch is its own state even with nothing confirmed", () => {
    const view = edcTerminalView(
      row({ mismatchCount: 1, flaggedCount: 1, bankStatus: "mismatch" }),
    );
    expect(view.state).toBe("mismatch");
    expect(view.settledIdr).toBe(0);
    expect(view.differenceIdr).toBe(1_600_000);
  });

  it("no_match: the file is in but hit none of the terminal's sales", () => {
    const view = edcTerminalView(row({ bankStatus: "no_match" }));
    expect(view).toMatchObject({
      state: "noMatch",
      settledIdr: 0,
      differenceIdr: 1_600_000,
    });
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
      row({ flaggedCount: 3 }), // awaiting
      row({
        terminalId: "00000000-0000-4000-8000-000000000002",
        settledIdr: 800_000,
        settledCount: 2,
        flaggedCount: 1,
        differenceIdr: 800_000,
        bankStatus: "matched",
      }),
    ];
    expect(flaggedAfterBankFile(rows)).toBe(1);
  });

  it("null stays null (server has no EDC figures)", () => {
    expect(flaggedAfterBankFile(null)).toBeNull();
  });

  // Review K P2: "nothing flagged" must not reassure before any bank file.
  it("is null (unknown) when every terminal still waits for the file", () => {
    expect(
      flaggedAfterBankFile([
        row({ flaggedCount: 3 }),
        row({
          terminalId: "00000000-0000-4000-8000-000000000002",
          flaggedCount: 0,
        }),
      ]),
    ).toBeNull();
  });

  // Re-review K: the "nothing to check" sentence needs EVERY terminal to have
  // a bank file; one still waiting keeps the count unknown.
  it("is null when one terminal reached 0 flagged but another still waits", () => {
    expect(
      flaggedAfterBankFile([
        row({
          settledIdr: 1_600_000,
          settledCount: 4,
          differenceIdr: 0,
          bankStatus: "matched",
        }),
        row({ terminalId: "00000000-0000-4000-8000-000000000002" }),
      ]),
    ).toBeNull();
  });

  it("still counts real flags while another terminal waits", () => {
    expect(
      flaggedAfterBankFile([
        row({ settledCount: 1, flaggedCount: 2, bankStatus: "matched" }),
        row({ terminalId: "00000000-0000-4000-8000-000000000002" }),
      ]),
    ).toBe(2);
  });

  it("is null without any terminal (no EDC sale to check)", () => {
    expect(flaggedAfterBankFile([])).toBeNull();
  });

  it("is 0 once a file reached a terminal and nothing is flagged", () => {
    expect(
      flaggedAfterBankFile([
        row({
          settledIdr: 1_600_000,
          settledCount: 4,
          differenceIdr: 0,
          bankStatus: "matched",
        }),
      ]),
    ).toBe(0);
  });
});

const settledRow = (over: Partial<EdcTerminalSettlement> = {}) =>
  row({
    settledIdr: 1_600_000,
    settledCount: 4,
    differenceIdr: 0,
    bankStatus: "matched",
    ...over,
  });

describe("edcNoticeTone (audit P2 3)", () => {
  it("info when every terminal is settled and nothing is flagged", () => {
    expect(edcNoticeTone([settledRow()], 0)).toBe("info");
  });
  it("danger for a mismatch or a no_match terminal", () => {
    expect(
      edcNoticeTone([row({ bankStatus: "mismatch", mismatchCount: 1 })], 1),
    ).toBe("danger");
    expect(edcNoticeTone([row({ bankStatus: "no_match" })], 0)).toBe("danger");
  });
  it("warning while waiting, partial, flagged or without figures", () => {
    expect(edcNoticeTone([row({})], null)).toBe("warning");
    expect(
      edcNoticeTone(
        [settledRow({ differenceIdr: 400_000, settledIdr: 1_200_000 })],
        0,
      ),
    ).toBe("warning");
    expect(edcNoticeTone([settledRow()], 2)).toBe("warning");
    expect(edcNoticeTone(null, null)).toBe("warning");
  });
});

describe("EdcUnmatchedNote (review K P2)", () => {
  const render = (count: number | null) =>
    renderToString(createElement(EdcUnmatchedNote, { count }));
  it("says nothing before any bank file (unknown is not zero)", () => {
    expect(render(null)).toBe("");
  });
  it("says nothing is flagged only when the count is a real 0", () => {
    expect(render(0)).toContain(t("posKasirDayclose.check.noUnmatched"));
  });
  it("names the count when some are flagged", () => {
    expect(render(2)).toContain(
      t("posKasirDayclose.check.unmatched", { count: 2 }),
    );
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
      row({
        settledIdr: 1_000_000,
        settledCount: 2,
        flaggedCount: 2,
        differenceIdr: 600_000,
        bankStatus: "matched",
      }),
    ]);
    expect(html).not.toContain("Menunggu file bank");
    expect(html).toContain(t("posKasirDayclose.check.settlementReceipt"));
    expect(html).toContain(t("posKasirDayclose.check.settlementBankLabel"));
    expect(t("posKasirDayclose.check.settlementBankLabel")).toBe(
      "Dikonfirmasi bank",
    );
    expect(html).toContain(t("posKasirDayclose.check.settlementDifference"));
    for (const amount of [1_600_000, 1_000_000, 600_000])
      expect(html).toContain(formatRupiah(amount));
  });

  it("says the file is in but matched nothing, with the server figures", () => {
    const html = render([row({ bankStatus: "no_match" })]);
    expect(html).toContain(t("posKasirDayclose.check.settlementStateNoMatch"));
    expect(html).not.toContain("Menunggu file bank");
    expect(html).toContain(formatRupiah(1_600_000));
  });

  it("keeps the pending and none texts", () => {
    expect(render(null)).toContain(
      t("posKasirDayclose.check.settlementPending"),
    );
    expect(render([])).toContain(t("posKasirDayclose.check.settlementNone"));
  });
});
