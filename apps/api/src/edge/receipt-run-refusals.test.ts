// Unit tests for the receipt run refusal codec (bead legend-hfq3z): what an
// edge reports to the cloud on its next pull (`receiptRefused=<id>:<reason>,...`)
// when it refused a pulled run because its prefix or id already exists locally.
// Pure functions; no database. Contract: packages/shared/src/edge/schemas.ts.
//
// Assumptions: ids are UUIDs written lowercase by the encoder and lowercased by
// the decoder (so two spellings of one id are a duplicate); at most 50 entries;
// the query string is at most 4000 characters.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_RUN_REFUSAL_MAX_ENTRIES,
  RECEIPT_RUN_REFUSAL_REASONS,
  decodeReceiptRunRefusals,
  encodeReceiptRunRefusals,
  receiptRunRefusalQuerySchema,
  type ReceiptRunRefusalReason,
} from "@starter/shared/edge";

const A = "11111111-1111-4111-8111-111111111111";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const many = (n: number) =>
  Array.from({ length: n }, () => `${randomUUID()}:prefix_used`).join(",");

describe("legend-hfq3z the refusal reasons", () => {
  it("are exactly prefix_used and id_used", () => {
    expect([...RECEIPT_RUN_REFUSAL_REASONS]).toEqual([
      "prefix_used",
      "id_used",
    ]);
  });
});

describe("legend-hfq3z encodeReceiptRunRefusals", () => {
  it("writes an empty report as an empty string", () => {
    expect(encodeReceiptRunRefusals(new Map())).toBe("");
  });

  it("writes <id>:<reason> entries sorted by id, ids lowercase, joined by a comma", () => {
    const report = new Map<string, ReceiptRunRefusalReason>([
      [B.toUpperCase(), "id_used"],
      [A, "prefix_used"],
    ]);
    expect(encodeReceiptRunRefusals(report)).toBe(
      `${A}:prefix_used,${B}:id_used`,
    );
  });

  it("does not depend on the insertion order", () => {
    const one = new Map<string, ReceiptRunRefusalReason>([
      [A, "prefix_used"],
      [B, "id_used"],
    ]);
    const two = new Map<string, ReceiptRunRefusalReason>([
      [B, "id_used"],
      [A, "prefix_used"],
    ]);
    expect(encodeReceiptRunRefusals(one)).toBe(encodeReceiptRunRefusals(two));
  });
});

describe("legend-hfq3z encodeReceiptRunRefusals caps the report at 50 entries", () => {
  // Ids sort as their number: ...-000000000000 < ...-000000000001 < ...
  const idOf = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const reportOf = (count: number, reverse = false) => {
    const ids = Array.from({ length: count }, (_, i) => idOf(i));
    if (reverse) ids.reverse();
    return new Map<string, ReceiptRunRefusalReason>(
      ids.map((id, i) => [id, i % 2 === 0 ? "prefix_used" : "id_used"]),
    );
  };

  it("allows at most 50 entries", () => {
    expect(RECEIPT_RUN_REFUSAL_MAX_ENTRIES).toBe(50);
  });

  it("60 refusals encode as 50 entries: the lowest ids, whatever the insertion order, and the value decodes and passes the query schema", () => {
    for (const reverse of [false, true]) {
      const encoded = encodeReceiptRunRefusals(reportOf(60, reverse));
      expect(encoded.split(",")).toHaveLength(50);
      const decoded = decodeReceiptRunRefusals(encoded);
      expect(decoded).not.toBeNull();
      expect([...decoded!.keys()]).toEqual(
        Array.from({ length: 50 }, (_, i) => idOf(i)),
      );
      expect(receiptRunRefusalQuerySchema.safeParse(encoded).success).toBe(
        true,
      );
    }
  });

  it("keeps the reasons of the kept ids", () => {
    const decoded = decodeReceiptRunRefusals(
      encodeReceiptRunRefusals(reportOf(60)),
    );
    expect(decoded?.get(idOf(0))).toBe("prefix_used");
    expect(decoded?.get(idOf(1))).toBe("id_used");
    expect(decoded?.has(idOf(50))).toBe(false);
  });

  it("exactly 50 refusals are all kept", () => {
    const report = reportOf(50);
    expect(decodeReceiptRunRefusals(encodeReceiptRunRefusals(report))).toEqual(
      report,
    );
  });
});

describe("legend-hfq3z decodeReceiptRunRefusals", () => {
  it("reads the empty string as an empty report", () => {
    expect(decodeReceiptRunRefusals("")).toEqual(new Map());
  });

  it("round-trips an encoded report", () => {
    const report = new Map<string, ReceiptRunRefusalReason>([
      [A, "prefix_used"],
      [B, "id_used"],
    ]);
    expect(decodeReceiptRunRefusals(encodeReceiptRunRefusals(report))).toEqual(
      report,
    );
  });

  it("lowercases ids and accepts any entry order", () => {
    expect(
      decodeReceiptRunRefusals(`${B.toUpperCase()}:id_used,${A}:prefix_used`),
    ).toEqual(
      new Map([
        [B, "id_used"],
        [A, "prefix_used"],
      ]),
    );
  });

  it("accepts 50 entries and refuses 51", () => {
    expect(decodeReceiptRunRefusals(many(50))?.size).toBe(50);
    expect(decodeReceiptRunRefusals(many(51))).toBeNull();
  });

  it("returns null for a malformed value (never a partial report)", () => {
    // Control: the same shape with valid content decodes.
    expect(decodeReceiptRunRefusals(`${A}:prefix_used`)).not.toBeNull();
    for (const bad of [
      A, // no reason
      `${A}:`, // empty reason
      `:prefix_used`, // empty id
      `${A}:other`, // unknown reason
      `${A}:PREFIX_USED`, // reasons are case sensitive
      `${A}:prefix_used:extra`,
      `not-a-uuid:prefix_used`,
      `${A.slice(0, 35)}:prefix_used`, // one character short
      `${A}:prefix_used,${A}:id_used`, // duplicate id
      `${A}:prefix_used,${A.toUpperCase()}:prefix_used`, // same id, other case
      `${A}:prefix_used,`, // trailing comma
      `,${A}:prefix_used`, // leading comma
      `${A}:prefix_used,,${B}:id_used`, // empty entry
      ` ${A}:prefix_used`, // whitespace
      `${A}:prefix_used,${B}`, // one good, one bad entry
    ])
      expect(decodeReceiptRunRefusals(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("legend-hfq3z receiptRunRefusalQuerySchema", () => {
  it("accepts the empty value and good entries, keeping the string as sent", () => {
    expect(receiptRunRefusalQuerySchema.safeParse("").success).toBe(true);
    const value = `${A}:prefix_used,${B}:id_used`;
    const parsed = receiptRunRefusalQuerySchema.parse(value);
    expect(parsed).toBe(value);
    // The query is parsed twice (route, then service): the output re-parses.
    expect(receiptRunRefusalQuerySchema.parse(parsed)).toBe(value);
    expect(receiptRunRefusalQuerySchema.safeParse(many(50)).success).toBe(true);
  });

  it("refuses a malformed value, more than 50 entries and an oversized string", () => {
    for (const bad of [
      "garbage",
      `${A}:other`,
      `bad-uuid:id_used`,
      `${A}:id_used,${A}:id_used`,
      many(51),
      `${A}:id_used,${"x".repeat(4_000)}`,
    ])
      expect(
        receiptRunRefusalQuerySchema.safeParse(bad).success,
        JSON.stringify(bad.slice(0, 40)),
      ).toBe(false);
    expect(receiptRunRefusalQuerySchema.safeParse(undefined).success).toBe(
      false,
    );
  });
});
