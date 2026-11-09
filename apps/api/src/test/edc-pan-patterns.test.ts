import { describe, expect, it } from "vitest";
import {
  ecrResultDetailsSchema,
  edcTransactionSchema,
  hasPanLengthDigits,
} from "@starter/shared/edc";

// Card-number patterns: digits split by spaces, tabs or dashes, repeated or mixed,
// must be caught the same way in the write path (provider answer) and the read
// path (stored ledger row). Reference columns use a 13+ digit threshold (a
// 12-digit RRN is legitimate); free text uses 12+. `hasPanLengthDigits` stays
// contiguous (see its tests).

const row = {
  id: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a11",
  tenantId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a12",
  outletId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a13",
  terminalId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a14",
  bank: "bca",
  reference: "R1",
  idempotencyKey: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a15",
  amountIdr: 1000,
  method: "card",
  status: "approved",
  trace: "TRACE1",
  approvalCode: null,
  rrn: null,
  cardType: null,
  maskedPan: null,
  responseCode: null,
  message: null,
  invoiceNo: null,
  batchNo: null,
  needsReconciliation: false,
  dispatchedAt: null,
  inquiryCount: 0,
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  completedAt: null,
};

// Separators beyond space, tab and dash (legend-deu7r): line breaks, NBSP
// (U+00A0), slash and underscore also split a card number in free text.
const oddSeparatorPans = [
  "4111\n1111\n1111\n1111",
  "4111\r\n1111\r\n1111\r\n1111",
  "4111 1111 1111 1111",
  "4111/1111/1111/1111",
  "4111_1111_1111_1111",
  "4111 \n 1111/1111_1111",
];

const spacedPans = [
  "4111 1111 1111 1111",
  "4111  1111  1111  1111",
  "4111 - 1111-1111 1111",
  "4111--1111--1111--1111",
  "4111-1111 1111-1111",
  "4111\t1111\t1111\t1111",
];

// Dots are thousands separators in rupiah amounts, never a card separator.
const rupiahAmount = "Rp 1.250.000.000.000";

describe("free-text message (write path)", () => {
  const write = (message: string) =>
    ecrResultDetailsSchema.parse({ message }).message;

  it("masks a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      expect(write(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("masks a 12-digit run, plain or split", () => {
    expect(write("kartu 411111111111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(write("kartu 4111 1111 1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(write("kartu 4111  1111--1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("masks a card number split by newline, CRLF, NBSP, slash or underscore", () => {
    for (const pan of oddSeparatorPans) {
      expect(write(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("keeps a date and a time written with slash or colon", () => {
    expect(write("tgl 2026/11/09 12:30:45 ok")).toBe(
      "tgl 2026/11/09 12:30:45 ok",
    );
    expect(write("ref 12345_67890 ok")).toBe("ref 12345_67890 ok");
  });

  it("masks a tab-separated card number", () => {
    expect(write("kartu 4111\t1111\t1111\t1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("keeps a rupiah amount written with dots", () => {
    expect(write(`total ${rupiahAmount} ok`)).toBe(`total ${rupiahAmount} ok`);
  });

  it("keeps an 11-digit run", () => {
    expect(write("ref 41111111111 ok")).toBe("ref 41111111111 ok");
    expect(write("ref 4111 1111 111 ok")).toBe("ref 4111 1111 111 ok");
  });
});

describe("free-text message (read path)", () => {
  const read = (message: string) =>
    edcTransactionSchema.parse({ ...row, message }).message;

  it("masks a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      expect(read(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("masks a 12-digit run, plain or split", () => {
    expect(read("kartu 411111111111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(read("kartu 4111 1111 1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("masks a card number split by newline, CRLF, NBSP, slash or underscore", () => {
    for (const pan of oddSeparatorPans) {
      expect(read(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("keeps a date and a time written with slash or colon", () => {
    expect(read("tgl 2026/11/09 12:30:45 ok")).toBe(
      "tgl 2026/11/09 12:30:45 ok",
    );
  });

  it("masks a tab-separated card number", () => {
    expect(read("kartu 4111\t1111\t1111\t1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("keeps a rupiah amount written with dots", () => {
    expect(read(`total ${rupiahAmount} ok`)).toBe(`total ${rupiahAmount} ok`);
  });

  it("keeps an 11-digit run", () => {
    expect(read("ref 41111111111 ok")).toBe("ref 41111111111 ok");
  });
});

describe("masks left by the old single-separator scrub (read path)", () => {
  // Rows masked by 0135 or the old write path can hold card digits next to a
  // mask, joined by a separator run the old pattern could not cross. They are
  // folded only when they show more than the first 6 / last 4 digits.
  const read = (message: string) =>
    edcTransactionSchema.parse({ ...row, message }).message;
  const M = "[disamarkan]";

  it("folds 5+ digits after or 7+ digits before a mask", () => {
    expect(read(`Kartu ${M} - 1111111 ditolak`)).toBe(`Kartu ${M} ditolak`);
    expect(read(`Kartu ${M}\t1111111 ditolak`)).toBe(`Kartu ${M} ditolak`);
    expect(read(`Kartu ${M} - 11 - 11111 ditolak`)).toBe(`Kartu ${M} ditolak`);
    expect(read(`Kartu 4111111 - ${M} ditolak`)).toBe(`Kartu ${M} ditolak`);
    expect(read(`Kartu 1111111\t${M} ditolak`)).toBe(`Kartu ${M} ditolak`);
    // Accepted loss: a 6-digit approval code joined by " - " is folded too.
    expect(read(`Kartu ${M} - 123456`)).toBe(`Kartu ${M}`);
  });

  it("keeps response codes and digits within first 6 / last 4", () => {
    for (const clean of [
      `Kartu ${M} - 51`,
      `Kartu ${M} 05`,
      `Kartu ${M} - 1111 ditolak`,
      `Kartu 4111 - ${M} ditolak`,
      `Kartu ${M} 12345`,
      `Kartu 411111 ${M}\t1111 ditolak`,
    ]) {
      expect(read(clean)).toBe(clean);
    }
  });

  it("write path: a response code after a card number goes with it", () => {
    // Dirty input: the card-number run is greedy across " - ", so the code
    // joined to it is masked too. PAN removal wins.
    expect(
      ecrResultDetailsSchema.parse({
        message: "Kartu 4111111111111111 - 51",
      }).message,
    ).toBe(`Kartu ${M}`);
  });
});

describe("reference columns on read", () => {
  const read = (value: string) =>
    edcTransactionSchema.parse({
      ...row,
      rrn: value,
      invoiceNo: value,
      batchNo: value,
    });

  it("drops a value with a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      const parsed = read(pan);
      expect(parsed.rrn).toBeNull();
      expect(parsed.invoiceNo).toBeNull();
      expect(parsed.batchNo).toBeNull();
    }
    const mixed = read("4111  1111-1111 1111");
    expect(mixed.rrn).toBeNull();
    expect(mixed.invoiceNo).toBeNull();
    expect(mixed.batchNo).toBeNull();
  });

  it("drops a tab-separated card number", () => {
    const parsed = read("4111\t1111\t1111\t1111");
    expect(parsed.rrn).toBeNull();
    expect(parsed.invoiceNo).toBeNull();
    expect(parsed.batchNo).toBeNull();
  });

  it("keeps a 12-digit RRN, plain or split", () => {
    for (const value of ["123456789012", "1234 5678 9012"]) {
      const parsed = read(value);
      expect(parsed.rrn).toBe(value);
      expect(parsed.invoiceNo).toBe(value);
      expect(parsed.batchNo).toBe(value);
    }
  });
});

describe("hasPanLengthDigits", () => {
  // Contiguous on purpose: it guards stored reference values, which are
  // alphanumeric, and must not flag order numbers split by a dash.
  it("is true for 13 to 19 digits in a row, alone or with letters", () => {
    for (let n = 13; n <= 19; n += 1) {
      const digits = "4".repeat(n);
      expect(hasPanLengthDigits(digits)).toBe(true);
      expect(hasPanLengthDigits(`RRN${digits}X`)).toBe(true);
    }
  });

  it("is false for an order number whose digits span the dash", () => {
    expect(hasPanLengthDigits("P261109-12345678")).toBe(false);
    expect(hasPanLengthDigits("GF261109-87654321")).toBe(false);
  });

  it("is false for a rupiah amount written with dots", () => {
    expect(hasPanLengthDigits(rupiahAmount)).toBe(false);
  });

  it("is false for 12 digits in a row", () => {
    expect(hasPanLengthDigits("123456789012")).toBe(false);
  });
});

describe("200-char tail left by the old write path (legend-lg45)", () => {
  // The old write path masked with a single-separator pattern and THEN cut the
  // message to 200 UTF-16 units, so a message exactly 200 long can end in a
  // card-number remnant. The tail rule applies ONLY to messages whose UTF-16
  // length is exactly 200; shorter or longer messages keep the old behaviour.
  // The tail rule runs on the READ path only (stored rows). The WRITE path
  // (provider answer) keeps the pre-change behaviour: chain, then
  // `.slice(0, 200)`. For these examples the chain leaves the tail alone, so a
  // 200-long input comes back unchanged on write.
  // Assumption: the output is cut to 200 code points (replacement can be longer
  // than the run), so expectations are built with the same cut.
  const write = (message: string) =>
    ecrResultDetailsSchema.parse({ message }).message;
  const read = (message: string) =>
    edcTransactionSchema.parse({ ...row, message }).message;

  // Pads the tail with "x" so the whole message is `len` UTF-16 units.
  const padded = (tail: string, len: number, lead = "") =>
    lead + "x".repeat(len - lead.length - tail.length) + tail;
  const cut200 = (s: string) => Array.from(s).slice(0, 200).join("");

  const emoji = "\u{1F600}"; // 2 UTF-16 units, 1 code point

  type Case = { name: string; tail: string; expectedTail: string };

  // Tails that must be rewritten when the message is exactly 200 long.
  const rewritten: Case[] = [
    {
      name: "multi-separator card cut at the end (10 digits)",
      tail: " 4111  1111  11",
      expectedTail: " [disamarkan]",
    },
    {
      name: "7+ digits then a cut mask prefix",
      tail: " 7777777  [disa",
      expectedTail: " [disamarkan]",
    },
    {
      name: "7+ digits then a cut mask missing only its closing bracket",
      tail: " 7777777  [disamarkan",
      expectedTail: " [disamarkan]",
    },
    {
      name: "7+ digits, a tab, then a cut mask missing its closing bracket",
      tail: " 7777777\t[disamarkan",
      expectedTail: " [disamarkan]",
    },
    {
      name: "digits, wide separator, then a bare opening bracket",
      tail: " 7777777  [",
      // replacement " [disamarkan]" no longer fits, so it is cut to 200
      expectedTail: " [disamarka",
    },
    {
      name: "digits left after a whole mask",
      tail: " [disamarkan] - 111",
      expectedTail: " [disamarkan]",
    },
    {
      name: "amount before a card tail of 7 digits",
      tail: " Rp 50.000  4111  111",
      expectedTail: " Rp 50.000  [disamark",
    },
    // legend-stetb: the old single-separator pattern could not cross a slash,
    // an underscore, a line break or an NBSP either, so a card cut at 200 and
    // joined by one of them left a remnant the tail rule must catch too.
    {
      name: "card cut at the end, joined by slashes",
      tail: " 4111/1111/11",
      expectedTail: " [disamarkan]",
    },
    {
      name: "card cut at the end, joined by underscores",
      tail: " 4111_1111_11",
      expectedTail: " [disamarkan]",
    },
    {
      name: "card cut at the end, joined by line breaks",
      tail: " 4111\r\n1111\r\n11",
      expectedTail: " [disamarkan]",
    },
    {
      name: "card cut at the end, joined by NBSP",
      tail: " 4111\u00a01111\u00a011",
      expectedTail: " [disamarkan]",
    },
    {
      name: "7+ digits, a slash, then a cut mask prefix",
      tail: " 7777777/[disa",
      expectedTail: " [disamarkan]",
    },
    {
      name: "7+ digits, an underscore, then a cut mask missing its bracket",
      tail: " 7777777_[disamarkan",
      expectedTail: " [disamarkan]",
    },
    {
      name: "digits left after a whole mask, joined by a slash",
      tail: " [disamarkan]/111",
      expectedTail: " [disamarkan]",
    },
    {
      name: "digits left after a whole mask, joined by an underscore",
      tail: " [disamarkan]_111",
      expectedTail: " [disamarkan]",
    },
    {
      name: "digits left after a whole mask, joined by a line break",
      tail: " [disamarkan]\n111",
      expectedTail: " [disamarkan]",
    },
    {
      name: "a date with slashes at the very end (accepted effect: 8 digits, wide separator)",
      tail: " 2026/11/09",
      expectedTail: " [disamarkan]",
    },
  ];

  // Tails that must stay exactly as they are at 200.
  const untouched: Case[] = [
    {
      name: "only 4 digits before a cut mask",
      tail: " 4111  [disa",
      expectedTail: "",
    },
    { name: "rupiah amount", tail: " Rp 1.500.000", expectedTail: "" },
    { name: "transaction code", tail: " TRX 12345678", expectedTail: "" },
    {
      name: "order id with a dash",
      tail: " ID P261109-1234",
      expectedTail: "",
    },
    { name: "date and time", tail: " 2026-11-09 10:00", expectedTail: "" },
    {
      name: "single-separator short number",
      tail: " 4111 1111",
      expectedTail: "",
    },
    {
      name: "amount then only 6 digits",
      tail: " Rp 50.000  4111  11",
      expectedTail: "",
    },
    {
      name: "only 6 digits joined by a slash",
      tail: " 12345/1",
      expectedTail: "",
    },
    {
      name: "date and time with slashes",
      tail: " 2026/11/09 10:00",
      expectedTail: "",
    },
    {
      name: "short code after a mask with a colon",
      tail: " [disamarkan]:51",
      expectedTail: "",
    },
  ];

  describe("write path (tail rule is NOT applied)", () => {
    const everyTail = [...rewritten, ...untouched];

    for (const c of everyTail) {
      it(`keeps a 200-long input as the pre-change result: ${c.name}`, () => {
        const input = padded(c.tail, 200);
        expect(input).toHaveLength(200);
        expect(write(input)).toBe(input);
      });
    }

    it("keeps a short code after a mask at exactly 200", () => {
      const input = padded(" [disamarkan] - 51", 200);
      expect(input).toHaveLength(200);
      expect(write(input)).toBe(input);
    });

    it("keeps the emoji-first 200-unit input as is", () => {
      const input = padded(" 4111\t111", 200, emoji);
      expect(input).toHaveLength(200);
      expect(write(input)).toBe(input);
    });

    it("still caps what it stores at 200 UTF-16 units", () => {
      const long = "x".repeat(250);
      expect(write(long)).toHaveLength(200);
    });

    it("still masks a plain single-separator card number in a 200-long input", () => {
      const input = padded(" 4111 1111 1111 1111", 200);
      const out = write(input);
      expect(out).toContain("[disamarkan]");
      expect(out).not.toMatch(/4111 1111/);
    });

    it("is idempotent", () => {
      for (const c of everyTail) {
        const once = write(padded(c.tail, 200));
        expect(write(once!)).toBe(once);
      }
    });

    it("differs from the read path on the rewritten tails", () => {
      for (const c of rewritten) {
        const input = padded(c.tail, 200);
        expect(read(input)).not.toBe(write(input));
      }
    });
  });

  describe("read path (tail rule applied)", () => {
    const reader = { parse: read };
    for (const c of rewritten) {
      it(`rewrites at exactly 200: ${c.name}`, () => {
        const input = padded(c.tail, 200);
        expect(input).toHaveLength(200);
        const expected = cut200(
          input.slice(0, input.length - c.tail.length) + c.expectedTail,
        );
        const out = reader.parse(input);
        expect(out).toBe(expected);
        expect(out!.length).toBeLessThanOrEqual(200);
        expect(out).not.toMatch(/\d{4}\s+\d/);
      });
    }

    for (const c of untouched) {
      it(`keeps at exactly 200: ${c.name}`, () => {
        const input = padded(c.tail, 200);
        expect(input).toHaveLength(200);
        expect(reader.parse(input)).toBe(input);
      });
    }

    it("leaves the same multi-separator tail alone at 199", () => {
      const input = padded(" 4111  1111  11", 199);
      expect(input).toHaveLength(199);
      expect(reader.parse(input)).toBe(input);
    });

    it("leaves a short code after a mask alone at 199", () => {
      const input = padded(" [disamarkan] - 51", 199);
      expect(input).toHaveLength(199);
      expect(reader.parse(input)).toBe(input);
    });

    it("removes a short code after a mask at exactly 200 (accepted effect)", () => {
      const input = padded(" [disamarkan] - 51", 200);
      expect(input).toHaveLength(200);
      const expected =
        input.slice(0, input.length - " [disamarkan] - 51".length) +
        " [disamarkan]";
      expect(reader.parse(input)).toBe(expected);
    });

    it("counts UTF-16 units: emoji first, 200 units but 199 code points", () => {
      const tail = " 4111\t111";
      const input = padded(tail, 200, emoji);
      expect(input).toHaveLength(200);
      expect(Array.from(input)).toHaveLength(199);
      const out = reader.parse(input);
      const masked = cut200(
        input.slice(0, input.length - tail.length) + " [disamarkan]",
      );
      // The read path and the SQL migration cut by code points (varchar).
      expect(out).toBe(masked);
      expect(out!.endsWith(" [disamark")).toBe(true);
      expect(Array.from(out!)).toHaveLength(200);
    });

    it("is idempotent: a second pass changes nothing", () => {
      for (const c of [...rewritten, ...untouched]) {
        const once = reader.parse(padded(c.tail, 200));
        expect(reader.parse(once!)).toBe(once);
      }
      const emojiOnce = reader.parse(padded(" 4111\t111", 200, emoji));
      expect(reader.parse(emojiOnce!)).toBe(emojiOnce);
    });
  });
});
