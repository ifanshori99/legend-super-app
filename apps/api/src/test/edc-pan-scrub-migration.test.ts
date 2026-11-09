// legend-5gub Part A + legend-tjwb: migrations 0135_edc_pan_scrub.sql and
// 0143_edc_pan_scrub_separators.sql mask card numbers left in old
// edc_transactions rows. 0135 matched digits split by ONE space or dash only;
// 0143 repeats the scrub for digits split by any number of spaces, tabs or
// dashes. The test inserts dirty and clean rows in two tenants as the owner,
// runs 0135 (one transaction), then 0143 twice (one transaction each), as a
// fresh database or a dev/staging database that already applied 0135 would,
// and checks the final state column by column.
//
// legend-lg45: 0143 also removes the card number tail the old write path (mask
// with the single-separator pattern, THEN cut to 200) left in messages that
// were exactly 200 UTF-16 units long. The length is checked on the original
// message, before the chain; the stored result must equal the JS read path
// (edcTransactionSchema.shape.message) on that original.
//
// Assumptions (recorded in the report):
// - "Card-like" = a run of digits with any number of spaces, tabs or dashes
//   between them: 13+ digits in rrn, invoice_no, batch_no, dispatch_batch_no
//   (a 12-digit RRN is legitimate), 12+ digits in every other text column.
//   Dots are not separators ("Rp 1.250.000.000.000" is an amount).
// - A masked_pan holding only a 13-19 digit number, plain or split by
//   separators, is masked to first 6 + '*' + last 4; anything else card-like
//   becomes NULL.
// - Rows are compared by id, so rows other test files leave behind do not
//   matter; the 0143 update count is asserted as ">= rows 0143 changed" on run
//   1 and exactly 0 on run 2.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { edcTransactionSchema, maskedPanSchema } from "@starter/shared/edc";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
} from "./floor-test-helpers.ts";
import type { IsolatedTenant } from "./floor-test-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const readMigration = (file: string) =>
  readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
const splitStatements = (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
const sql0143 = readMigration("0143_edc_pan_scrub_separators.sql");
const statements0135 = splitStatements(readMigration("0135_edc_pan_scrub.sql"));
const statements0143 = splitStatements(sql0143);

// Per-column oracle (write-path thresholds, any spaces/tabs/dashes between).
const REF_COLUMNS = new Set([
  "rrn",
  "invoice_no",
  "batch_no",
  "dispatch_batch_no",
]);
const REF_CARD_LIKE = /\d(?:[ \t-]*\d){12,}/;
const TEXT_CARD_LIKE = /\d(?:[ \t-]*\d){11,}/;
const cardLike = (col: string, value: string) =>
  (REF_COLUMNS.has(col) ? REF_CARD_LIKE : TEXT_CARD_LIKE).test(value);

const PAN = "4111111111111111";
const PAN_SPACED = "4111 1111 1111 1111";
const PAN_DASHED = "4111-1111-1111-1111";
// Separator forms 0135 missed.
const PAN_DOUBLE = "4111  1111  1111  1111";
const PAN_MIXED = "4111 - 1111-1111 1111";
const PAN_DDASH = "4111--1111--1111--1111";
const PAN_TAB = "4111\t1111\t1111\t1111";
// Same forms, short enough for the varchar(20) reference columns.
const REF20_DOUBLE = "4111  1111  11111111";
const REF20_MIXED = "4111 - 11111111 1111";
const REF20_DDASH = "4111--1111--11111111";
const SCRUBBED = "[disamarkan]";
/** Digits the old single-separator scrub left next to a mask, joined by a
 * separator run it could not cross: 7+ before or 5+ after the mask. */
const LEFTOVER =
  /\d(?:[ \t-]*\d){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]|\[disamarkan\](?:[ \t-]{2,}|\t)\d(?:[ \t-]*\d){4,}/;
const MASKED_16 = "411111******1111";

/** Digits of a 12..20 digit card number split by repeated and mixed separators. */
const DIGITS = "41111111111111112222";
const spread = (n: number) =>
  `${DIGITS.slice(0, 4)}  ${DIGITS.slice(4, 8)} -${DIGITS.slice(8, n)}`;
const maskOf = (n: number) =>
  DIGITS.slice(0, 6) + "*".repeat(n - 10) + DIGITS.slice(n - 4, n);

type Cols = {
  card_type: string | null;
  rrn: string | null;
  invoice_no: string | null;
  batch_no: string | null;
  dispatch_batch_no: string | null;
  message: string | null;
  masked_pan: string | null;
};
const SCRUB_COLUMNS = [
  "card_type",
  "rrn",
  "invoice_no",
  "batch_no",
  "dispatch_batch_no",
  "message",
  "masked_pan",
] as const;

type Spec = {
  name: string;
  status?: "approved" | "pending" | "declined";
  cols: Partial<Cols>;
  /** Expected scrubbed columns; absent key = unchanged. */
  expect?: Partial<Cols>;
  /** Several acceptable results (ambiguous case). */
  expectOneOf?: Partial<Cols>[];
};

const cleanCols: Partial<Cols> = {
  card_type: "VISA",
  rrn: "123456789012",
  invoice_no: "000123",
  batch_no: "000045",
  dispatch_batch_no: "000044",
  message: "Transaksi disetujui",
  masked_pan: "411111******1111",
};

// ---- legend-lg45: 200-char tails left by the old write path
/** UTF-16 length, as JS `.length` (and the SQL `length + length(non-BMP)`). */
const cut200 = (text: string) => Array.from(text).slice(0, 200).join("");
/** `x` padding so the message is `length` UTF-16 units long, ending in `tail`. */
const padTo = (tail: string, length = 200) =>
  "x".repeat(length - tail.length) + tail;
/** Emoji first: UTF-16 length 200, only 199 characters. */
const padEmoji = (tail: string) => "😀" + "x".repeat(198 - tail.length) + tail;
/** F1: an earlier card number the chain shortens, then a cut card at the end. */
const F1_HEAD = "A 4111  1111  1111  1111 B ";
const F1_TAIL = " 5500  0000  00";
const f1Original = (length: number) =>
  F1_HEAD + "x".repeat(length - F1_HEAD.length - F1_TAIL.length) + F1_TAIL;
const f1Chain = (length: number) =>
  `A ${SCRUBBED} B ` + "x".repeat(length - F1_HEAD.length - F1_TAIL.length);
/** Tail remnants the tail rule must leave nowhere in a 200-long original. */
const TAIL_AFTER_MASK =
  /\[disamarkan\](?:[ \t-]{2,}|\t)\d(?:[ \t-]*\d)*[ \t-]*$/;
const TAIL_CARD_RUN =
  /(?<!\d|\d[.,])\d(?=(?:[ \t-]*\d){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*\d)*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$/;
/** Spec names whose 200-long original must end without a tail remnant. */
const tailRemoved: string[] = [];

/** 200-long message ending in `tail`; `after` replaces the tail (cut to 200). */
const tailSpec = (name: string, tail: string, after?: string): Spec => {
  const message = padTo(tail);
  if (after === undefined) return { name: `tail-${name}`, cols: { message } };
  tailRemoved.push(`tail-${name}`);
  return {
    name: `tail-${name}`,
    status: "declined",
    cols: { message },
    expect: { message: cut200(message.slice(0, -tail.length) + after) },
  };
};

const specs: Spec[] = [
  // ---- clean rows: must stay byte-identical
  { name: "clean-full", cols: cleanCols },
  { name: "clean-12-digit-rrn", cols: { rrn: "123456789012" } },
  { name: "clean-nulls", cols: {} },
  {
    name: "clean-11-digits-spaced-in-message",
    status: "declined",
    cols: { message: "Ref 1234 5678 901 ditolak, kode 51" },
  },
  // 12-digit runs: masked in card_type, message and masked_pan like the write
  // path (a 12-digit card number exists), kept in the reference columns.
  {
    name: "message-12-digits-spaced",
    status: "declined",
    cols: { message: "Ref 1234 5678 9012 ditolak, kode 51" },
    expect: { message: "Ref [disamarkan] ditolak, kode 51" },
  },
  {
    name: "card-type-12-digits",
    cols: { card_type: "4111 1111 1111" },
    expect: { card_type: "UNKNOWN" },
  },
  {
    name: "masked-pan-12-digits",
    cols: { masked_pan: "411111111111" },
    expect: { masked_pan: null },
  },
  { name: "clean-masked-x", cols: { masked_pan: "4111XXXXXX1111" } },
  // ---- PAN in each column separately
  {
    name: "card-type-plain",
    cols: { card_type: PAN },
    expect: { card_type: "UNKNOWN" },
  },
  {
    name: "card-type-spaced",
    cols: { card_type: PAN_SPACED },
    expect: { card_type: "UNKNOWN" },
  },
  {
    name: "card-type-dashed",
    cols: { card_type: PAN_DASHED },
    expect: { card_type: "UNKNOWN" },
  },
  { name: "rrn-plain", cols: { rrn: PAN }, expect: { rrn: null } },
  { name: "rrn-spaced", cols: { rrn: PAN_SPACED }, expect: { rrn: null } },
  { name: "rrn-dashed", cols: { rrn: PAN_DASHED }, expect: { rrn: null } },
  {
    name: "invoice-plain",
    cols: { invoice_no: PAN },
    expect: { invoice_no: null },
  },
  {
    name: "invoice-dashed",
    cols: { invoice_no: PAN_DASHED },
    expect: { invoice_no: null },
  },
  { name: "batch-plain", cols: { batch_no: PAN }, expect: { batch_no: null } },
  {
    name: "batch-spaced",
    cols: { batch_no: PAN_SPACED },
    expect: { batch_no: null },
  },
  {
    name: "dispatch-batch-plain",
    cols: { dispatch_batch_no: PAN },
    expect: { dispatch_batch_no: null },
  },
  {
    name: "dispatch-batch-dashed",
    cols: { dispatch_batch_no: PAN_DASHED },
    expect: { dispatch_batch_no: null },
  },
  // ---- PAN inside message text
  {
    name: "message-plain",
    cols: { message: `Kartu ${PAN} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-spaced",
    cols: { message: `Kartu ${PAN_SPACED} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-dashed",
    cols: { message: `Kartu ${PAN_DASHED} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-two-pans",
    // The trailing 12-digit run is masked too: message uses the 12+ threshold.
    cols: { message: `A ${PAN} | B 5500-0000-0000-0004 | juga 123456789012` },
    expect: { message: `A ${SCRUBBED} | B ${SCRUBBED} | juga ${SCRUBBED}` },
  },
  {
    name: "message-only-pan",
    cols: { message: PAN },
    expect: { message: SCRUBBED },
  },
  // ---- masked_pan
  {
    name: "masked-pan-16",
    cols: { masked_pan: PAN },
    expect: { masked_pan: "411111******1111" },
  },
  {
    name: "masked-pan-13",
    cols: { masked_pan: "4111111111222" },
    expect: { masked_pan: "411111***1222" },
  },
  {
    name: "masked-pan-19",
    cols: { masked_pan: "4111111111111111222" },
    expect: { masked_pan: "411111*********1222" },
  },
  {
    name: "masked-pan-20-digits-not-a-pan-shape",
    cols: { masked_pan: "41111111111111112222" },
    expect: { masked_pan: null },
  },
  {
    name: "masked-pan-card-number-with-letters",
    cols: { masked_pan: "4111111111111111xx" },
    expect: { masked_pan: null },
  },
  {
    name: "masked-pan-spaced",
    status: "pending",
    cols: { masked_pan: PAN_SPACED },
    expect: { masked_pan: "411111******1111" },
  },
  {
    name: "masked-pan-dashed",
    cols: { masked_pan: PAN_DASHED },
    expect: { masked_pan: "411111******1111" },
  },
  // ---- every column dirty at once, non-approved status
  {
    name: "all-columns-dirty-approved",
    cols: {
      card_type: PAN,
      rrn: PAN_SPACED,
      invoice_no: PAN_DASHED,
      batch_no: PAN,
      dispatch_batch_no: PAN_SPACED,
      message: `PAN ${PAN} / ${PAN_DASHED}`,
      masked_pan: PAN,
    },
    expect: {
      card_type: "UNKNOWN",
      rrn: null,
      invoice_no: null,
      batch_no: null,
      dispatch_batch_no: null,
      message: `PAN ${SCRUBBED} / ${SCRUBBED}`,
      masked_pan: "411111******1111",
    },
  },
  {
    name: "all-columns-dirty-pending",
    status: "pending",
    cols: {
      card_type: PAN_DASHED,
      rrn: PAN,
      message: `x ${PAN_SPACED}`,
      masked_pan: PAN,
    },
    expect: {
      card_type: "UNKNOWN",
      rrn: null,
      message: `x ${SCRUBBED}`,
      masked_pan: "411111******1111",
    },
  },
  // ---- a dirty column next to clean ones: clean columns stay
  {
    name: "one-dirty-keeps-clean-columns",
    cols: { ...cleanCols, rrn: PAN },
    expect: { rrn: null },
  },
  // ---- legend-tjwb: repeated, mixed and tab separators (0143)
  ...(
    [
      ["double", PAN_DOUBLE, REF20_DOUBLE],
      ["mixed", PAN_MIXED, REF20_MIXED],
      ["ddash", PAN_DDASH, REF20_DDASH],
      ["tab", PAN_TAB, PAN_TAB],
    ] as const
  ).flatMap(([form, pan, ref20]): Spec[] => [
    {
      name: `card-type-${form}`,
      cols: { card_type: pan },
      expect: { card_type: "UNKNOWN" },
    },
    { name: `rrn-${form}`, cols: { rrn: pan }, expect: { rrn: null } },
    {
      name: `invoice-${form}`,
      cols: { invoice_no: ref20 },
      expect: { invoice_no: null },
    },
    {
      name: `batch-${form}`,
      cols: { batch_no: ref20 },
      expect: { batch_no: null },
    },
    {
      name: `dispatch-batch-${form}`,
      cols: { dispatch_batch_no: ref20 },
      expect: { dispatch_batch_no: null },
    },
    {
      name: `message-${form}`,
      status: "declined",
      cols: { message: `Kartu ${pan} ditolak` },
      // "4111 - 1111-1111 1111": 0135 runs first and masks only the
      // single-separator 12-digit tail. The 4-digit head left in front of the
      // mask is within the first-6 display rule, so 0143 keeps it.
      expect: {
        message:
          form === "mixed"
            ? `Kartu 4111 - ${SCRUBBED} ditolak`
            : `Kartu ${SCRUBBED} ditolak`,
      },
    },
    {
      name: `masked-pan-${form}`,
      cols: { masked_pan: pan },
      // mixed: 0135 sees the 12-digit tail, the value is not its bare PAN
      // shape, so 0135 already sets NULL.
      expect: { masked_pan: form === "mixed" ? null : MASKED_16 },
    },
  ]),
  // ---- 0135 leftovers: 0135 (and the old write path) masked only the
  // single-separator part of a run. Digits it left next to the mask, joined by
  // a separator run it could not cross (not exactly one space or dash), are
  // folded into the mask when they show more than the first 6 / last 4.
  {
    // Known, accepted loss: a 6-digit approval code after " - " looks like
    // the end of a 17-19 digit card and is folded.
    name: "message-leftover-approval-code-folded",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} - 123456` },
    expect: { message: `Kartu ${SCRUBBED}` },
  },
  {
    name: "message-0135-leftover-tail",
    status: "declined",
    cols: { message: "Kartu 411111111111 - 1111111 ditolak" },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-0135-leftover-head",
    status: "declined",
    cols: { message: "Kartu 4111111 - 411111111111 ditolak" },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-0135-leftover-tab-tail",
    status: "declined",
    cols: { message: "Kartu 411111111111\t1111111 ditolak" },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-leftover-tail-in-groups",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} - 11 - 11111 ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  {
    name: "message-leftover-head-tab",
    status: "declined",
    cols: { message: `Kartu 1111111\t${SCRUBBED} ditolak` },
    expect: { message: `Kartu ${SCRUBBED} ditolak` },
  },
  // ---- clean rows with digits next to a mask: must stay byte-identical
  // (response codes after a mask written by the old write path; groups
  // within first 6 / last 4; a single space the old scrub would have crossed).
  {
    name: "clean-marker-response-code-dash",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} - 51` },
  },
  {
    name: "clean-marker-response-code-space",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} 05` },
  },
  {
    name: "clean-marker-last-4",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} - 1111 ditolak` },
  },
  {
    name: "clean-marker-first-4",
    status: "declined",
    cols: { message: `Kartu 4111 - ${SCRUBBED} ditolak` },
  },
  {
    name: "clean-marker-single-space-digits",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} 12345` },
  },
  {
    name: "clean-marker-first-6-last-4",
    status: "declined",
    cols: { message: `Kartu 411111 ${SCRUBBED}\t1111 ditolak` },
  },
  {
    name: "clean-marker-apart-from-digits",
    status: "declined",
    cols: { message: `Kartu ${SCRUBBED} kode 51` },
  },
  // ---- boundary lengths 12..19 with repeated and mixed separators
  ...[12, 13, 14, 15, 16, 17, 18, 19].map((n): Spec => ({
    name: `boundary-${n}-digits`,
    cols: {
      card_type: spread(n),
      rrn: spread(n),
      message: `Ref ${spread(n)} ok`,
      masked_pan: spread(n),
      // varchar(20): spread(n) is n + 4 chars.
      ...(n <= 16
        ? {
            invoice_no: spread(n),
            batch_no: spread(n),
            dispatch_batch_no: spread(n),
          }
        : {}),
    },
    expect: {
      card_type: "UNKNOWN",
      message: `Ref ${SCRUBBED} ok`,
      // 12 digits: card-like in masked_pan, but not a 13-19 digit PAN.
      masked_pan: n === 12 ? null : maskOf(n),
      // 12 digits stay in the reference columns (legitimate RRN length).
      ...(n >= 13
        ? {
            rrn: null,
            ...(n <= 16
              ? { invoice_no: null, batch_no: null, dispatch_batch_no: null }
              : {}),
          }
        : {}),
    },
  })),
  {
    name: "masked-pan-20-digits-separated",
    cols: { masked_pan: "4111111111  1111112222" },
    expect: { masked_pan: null },
  },
  {
    name: "clean-11-digits-double-spaced",
    status: "declined",
    cols: {
      message: "Ref 1234  5678  901 ditolak, kode 51",
      rrn: "1234  5678  9012",
      invoice_no: "1234\t5678\t9012",
      masked_pan: MASKED_16,
    },
  },
  {
    name: "clean-dotted-amount",
    cols: { message: "Total Rp 1.250.000.000.000 lunas" },
  },
  // ---- legend-lg45: exactly 200 long, cut card number at the end
  tailSpec("multi-separator", " 4111  1111  11", ` ${SCRUBBED}`),
  tailSpec("tab-separated", " 4111\t111", ` ${SCRUBBED}`),
  tailSpec("cut-mask-after-7-digits", " 7777777  [disa", ` ${SCRUBBED}`),
  tailSpec("cut-mask-bracket-only", " 7777777  [", ` ${SCRUBBED}`),
  tailSpec(
    "cut-mask-no-closing-bracket",
    " 7777777  [disamarkan",
    ` ${SCRUBBED}`,
  ),
  tailSpec(
    "cut-mask-no-closing-bracket-tab",
    " 7777777\t[disamarkan",
    ` ${SCRUBBED}`,
  ),
  tailSpec("digits-after-mask", " [disamarkan] - 111", ` ${SCRUBBED}`),
  // Known, accepted loss: a real short code after a mask at the very end of a
  // 200-long message cannot be told from the end of a cut card.
  tailSpec(
    "response-code-after-mask-accepted",
    " [disamarkan] - 51",
    ` ${SCRUBBED}`,
  ),
  tailSpec(
    "amount-then-card",
    " Rp 50.000  4111  111",
    ` Rp 50.000  ${SCRUBBED}`,
  ),
  (() => {
    tailRemoved.push("tail-emoji-utf16-200");
    return {
      name: "tail-emoji-utf16-200",
      status: "declined" as const,
      cols: { message: padEmoji(" 4111\t111") },
      expect: { message: cut200(`😀${"x".repeat(189)} ${SCRUBBED}`) },
    };
  })(),
  (() => {
    // F1: the chain shortens this row (the earlier card becomes one mask), so
    // the 200 check must run on the original or the tail would leak.
    tailRemoved.push("tail-two-cards-chain-shortens");
    return {
      name: "tail-two-cards-chain-shortens",
      status: "declined" as const,
      cols: { message: f1Original(200) },
      expect: { message: `${f1Chain(200)} ${SCRUBBED}` },
    };
  })(),
  // 200 long, left alone
  tailSpec("four-digits-cut-mask", " 4111  [disa"),
  tailSpec("rupiah-amount", " Rp 1.500.000"),
  tailSpec("trx-number", " TRX 12345678"),
  tailSpec("id-with-dash", " ID P261109-1234"),
  tailSpec("timestamp", " 2026-11-09 10:00"),
  tailSpec("single-separator-8-digits", " 4111 1111"),
  tailSpec("amount-then-6-digits", " Rp 50.000  4111  11"),
  // not exactly 200 long: the tail rule does not run
  {
    name: "tail-multi-separator-199",
    cols: { message: padTo(" 4111  1111  11", 199) },
  },
  {
    name: "tail-response-code-after-mask-199",
    cols: { message: padTo(" [disamarkan] - 51", 199) },
  },
  {
    // Same F1 row, 199 long: only the chain applies, the cut card stays.
    name: "tail-two-cards-chain-shortens-199",
    status: "declined",
    cols: { message: f1Original(199) },
    expect: { message: `${f1Chain(199)}${F1_TAIL}` },
  },
];

type Fixture = {
  label: "A" | "B";
  tenantId: string;
  outletId: string;
  terminalId: string;
  /** spec.name -> row id */
  ids: Map<string, string>;
  specs: Spec[];
};

const { tenant: seededTenant, outlets: seededOutlets } = cafeLegendFixtures;
let isolated: IsolatedTenant;
let fixA: Fixture;
let fixB: Fixture;
let seq = 0;

/** FORCE RLS is on: every read and write carries the tenant settings. */
async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertRow(
  client: PoolClient,
  row: {
    id: string;
    tenantId: string;
    outletId: string;
    terminalId: string;
    label: string;
    status?: Spec["status"];
    cols: Partial<Cols>;
  },
) {
  const status = row.status ?? "approved";
  seq += 1;
  await client.query(
    `INSERT INTO edc_transactions
       (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
        request_fingerprint, amount_idr, method, status, trace, completed_at,
        card_type, rrn, invoice_no, batch_no, dispatch_batch_no, message,
        masked_pan, updated_at, created_at)
     VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-scrub', $7, 'card', $8::varchar, $9,
             CASE WHEN $8::varchar = 'pending' THEN NULL ELSE '2024-01-02T03:04:05Z'::timestamptz END,
             $10, $11, $12, $13, $14, $15, $16,
             '2024-01-02T03:04:06Z', '2024-01-02T03:00:00Z')`,
    [
      row.id,
      row.tenantId,
      row.outletId,
      row.terminalId,
      `REF-SCRUB-${row.label}-${seq}`,
      randomUUID(),
      10_000 + seq,
      status,
      `TS${row.label}${String(seq).padStart(6, "0")}`,
      row.cols.card_type ?? null,
      row.cols.rrn ?? null,
      row.cols.invoice_no ?? null,
      row.cols.batch_no ?? null,
      row.cols.dispatch_batch_no ?? null,
      row.cols.message ?? null,
      row.cols.masked_pan ?? null,
    ],
  );
}

async function makeFixture(
  label: "A" | "B",
  tenantId: string,
  outletId: string,
  subset: Spec[],
): Promise<Fixture> {
  const terminalId = randomUUID();
  const ids = new Map<string, string>();
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-SCRUB', 'Test EDC', 'lan',
               ARRAY['card','qris'], 'active')`,
      [terminalId, tenantId, outletId, `TID-${terminalId.slice(0, 8)}`],
    );
    for (const spec of subset) {
      const id = randomUUID();
      await insertRow(client, {
        id,
        tenantId,
        outletId,
        terminalId,
        label,
        status: spec.status,
        cols: spec.cols,
      });
      ids.set(spec.name, id);
    }
  });
  return { label, tenantId, outletId, terminalId, ids, specs: subset };
}

type RowJson = Record<string, unknown>;

async function snapshot(fix: Fixture): Promise<Map<string, RowJson>> {
  const rows = await asTenant(fix.tenantId, (client) =>
    client.query<{ id: string; j: RowJson }>(
      "SELECT id, to_jsonb(t) AS j FROM edc_transactions t WHERE id = ANY($1::uuid[])",
      [[...fix.ids.values()]],
    ),
  );
  return new Map(rows.rows.map((r) => [r.id, r.j]));
}

/** Rows of edc_transactions updated so far in the current transaction. */
async function updatedInTransaction(client: PoolClient): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT n_tup_upd::int AS n FROM pg_stat_xact_user_tables
     WHERE relid = 'public.edc_transactions'::regclass`,
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * A whole migration file in ONE transaction, as the drizzle migrator does.
 * Returns the number of edc_transactions rows it updated.
 */
async function runMigration(stmts: string[]): Promise<number> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const start = await updatedInTransaction(client);
    for (const statement of stmts) await client.query(statement);
    const updated = (await updatedInTransaction(client)) - start;
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function forcedRls(): Promise<boolean> {
  const result = await owner.query<{ forced: boolean }>(
    `SELECT relforcerowsecurity AS forced FROM pg_class
     WHERE oid = 'public.edc_transactions'::regclass`,
  );
  return result.rows[0].forced;
}

const isDirty = (spec: Spec) =>
  spec.expect !== undefined || spec.expectOneOf !== undefined;

let before: Map<string, RowJson>;
let after0135: Map<string, RowJson>;
let afterFirst: Map<string, RowJson>;
let afterSecond: Map<string, RowJson>;
let firstRunUpdated = -1;
let secondRunUpdated = -1;
let dirtyCount = 0;

const snapshotAll = async () =>
  new Map([...(await snapshot(fixA)), ...(await snapshot(fixB))]);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // 0135: SET LOCAL lock_timeout, NO FORCE, UPDATE, FORCE, reset lock_timeout.
  expect(statements0135.length).toBe(5);
  isolated = await createIsolatedTenant(`pan-${randomUUID().slice(0, 8)}`);
  // Tenant A: seeded fixture tenant, all specs. Tenant B: isolated tenant,
  // a mixed subset, so a tenant-scoped migration bug would show.
  const subsetB = specs.filter((_, i) => i % 2 === 0 || i < 8);
  fixA = await makeFixture("A", seededTenant.id, seededOutlets[0].id, specs);
  fixB = await makeFixture("B", isolated.tenantId, isolated.outletId, subsetB);
  dirtyCount =
    fixA.specs.filter(isDirty).length + fixB.specs.filter(isDirty).length;

  before = await snapshotAll();
  await runMigration(statements0135);
  after0135 = await snapshotAll();
  firstRunUpdated = await runMigration(statements0143);
  afterFirst = await snapshotAll();
  secondRunUpdated = await runMigration(statements0143);
  afterSecond = await snapshotAll();
});

afterAll(async () => {
  for (const fix of [fixA, fixB]) {
    if (!fix) continue;
    await asTenant(fix.tenantId, async (client) => {
      await client.query(
        "DELETE FROM edc_transactions WHERE id = ANY($1::uuid[])",
        [[...fix.ids.values()]],
      );
      await client.query("DELETE FROM payment_edc_terminals WHERE id = $1", [
        fix.terminalId,
      ]);
    });
  }
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

/** The UPDATE inside the 0143 DO block, run alone. */
const bareUpdate0143 = () => {
  const match = /UPDATE "edc_transactions"[\s\S]*?;/.exec(sql0143);
  if (!match) throw new Error("0143 holds no UPDATE");
  return match[0];
};

describe("EDC-01 legend-5gub + legend-tjwb migrations 0135 + 0143 PAN scrub", () => {
  it("0143 is one DO block: NO FORCE, UPDATE and FORCE commit or fail together", () => {
    expect(statements0143.length).toBe(1);
    const body = statements0143[0];
    expect(body).toMatch(/^(--[^\n]*\n)*DO \$scrub\$/);
    const noForce = body.indexOf("NO FORCE ROW LEVEL SECURITY");
    const update = body.indexOf('UPDATE "edc_transactions"');
    const force = body.lastIndexOf(
      '"edc_transactions" FORCE ROW LEVEL SECURITY',
    );
    expect(noForce).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(noForce);
    expect(force).toBeGreaterThan(update);
  });

  it("covers both tenants with dirty and clean rows", () => {
    expect(before.size).toBe(fixA.ids.size + fixB.ids.size);
    expect(dirtyCount).toBeGreaterThan(30);
    expect(fixB.specs.some(isDirty)).toBe(true);
    expect(fixB.specs.some((s) => !isDirty(s))).toBe(true);
  });

  it("0135 alone leaves repeated, mixed and tab separated card numbers (the bug 0143 fixes)", () => {
    const after = (name: string) => after0135.get(fixA.ids.get(name)!)!;
    expect(after("rrn-double").rrn).toBe(PAN_DOUBLE);
    expect(after("rrn-mixed").rrn).toBe(PAN_MIXED);
    expect(after("rrn-tab").rrn).toBe(PAN_TAB);
    expect(after("message-ddash").message).toBe(`Kartu ${PAN_DDASH} ditolak`);
    expect(after("masked-pan-double").masked_pan).toBe(PAN_DOUBLE);
    expect(after("boundary-13-digits").rrn).toBe(spread(13));
  });

  it("masks every dirty column exactly as specified", () => {
    for (const fix of [fixA, fixB]) {
      for (const spec of fix.specs.filter(isDirty)) {
        const id = fix.ids.get(spec.name)!;
        const row = afterFirst.get(id)!;
        const prior = before.get(id)!;
        const candidates = spec.expectOneOf ?? [spec.expect!];
        const matches = candidates.some((exp) =>
          SCRUB_COLUMNS.every((col) => {
            const want = col in exp ? exp[col] : prior[col];
            return row[col] === want;
          }),
        );
        if (!matches) {
          const got = Object.fromEntries(SCRUB_COLUMNS.map((c) => [c, row[c]]));
          throw new Error(
            `${fix.label}/${spec.name}: got ${JSON.stringify(got)}, wanted one of ${JSON.stringify(
              candidates,
            )} over ${JSON.stringify(
              Object.fromEntries(SCRUB_COLUMNS.map((c) => [c, prior[c]])),
            )}`,
          );
        }
      }
    }
  });

  it("leaves amount, status, completed_at, updated_at, tenant and outlet untouched on every row", () => {
    for (const [id, prior] of before) {
      const row = afterFirst.get(id)!;
      for (const col of [
        "amount_idr",
        "status",
        "completed_at",
        "updated_at",
        "created_at",
        "tenant_id",
        "outlet_id",
        "terminal_id",
        "reference",
        "trace",
        "approval_code",
        "needs_reconciliation",
      ]) {
        expect(row[col], `${id} ${col}`).toEqual(prior[col]);
      }
    }
  });

  it("changes only the scrub columns of dirty rows and nothing in clean rows", () => {
    for (const fix of [fixA, fixB]) {
      for (const spec of fix.specs) {
        const id = fix.ids.get(spec.name)!;
        const prior = before.get(id)!;
        const row = afterFirst.get(id)!;
        if (!isDirty(spec)) {
          // Byte-identical full row.
          expect(JSON.stringify(row), `${fix.label}/${spec.name}`).toBe(
            JSON.stringify(prior),
          );
        } else {
          const rest = (r: RowJson) =>
            Object.fromEntries(
              Object.entries(r).filter(
                ([k]) => !(SCRUB_COLUMNS as readonly string[]).includes(k),
              ),
            );
          expect(rest(row), `${fix.label}/${spec.name}`).toEqual(rest(prior));
        }
      }
    }
  });

  it("keeps clean columns of a dirty row and clean 12-digit values as they were", () => {
    const id = fixA.ids.get("one-dirty-keeps-clean-columns")!;
    const row = afterFirst.get(id)!;
    expect(row).toMatchObject({
      card_type: "VISA",
      rrn: null,
      invoice_no: "000123",
      batch_no: "000045",
      dispatch_batch_no: "000044",
      message: "Transaksi disetujui",
      masked_pan: MASKED_16,
    });
    const rrnRow = afterFirst.get(fixA.ids.get("clean-12-digit-rrn")!)!;
    expect(rrnRow.rrn).toBe("123456789012");
    const boundary12 = afterFirst.get(fixA.ids.get("boundary-12-digits")!)!;
    expect(boundary12).toMatchObject({
      rrn: spread(12),
      invoice_no: spread(12),
      batch_no: spread(12),
      dispatch_batch_no: spread(12),
    });
  });

  it("a 200-long tail left by the old write path is removed, a 199-long one is not (legend-lg45)", () => {
    const stored = (name: string) =>
      afterFirst.get(fixA.ids.get(name)!)!.message as string;
    for (const name of tailRemoved) {
      const message = stored(name);
      expect(message, name).toBeTypeOf("string");
      expect(TAIL_AFTER_MASK.test(message), name).toBe(false);
      expect(TAIL_CARD_RUN.test(message), name).toBe(false);
      expect(Array.from(message).length, name).toBeLessThanOrEqual(200);
    }
    // Wrong length: the cut card number stays.
    expect(stored("tail-multi-separator-199")).toMatch(/ 4111 {2}1111 {2}11$/);
    expect(stored("tail-two-cards-chain-shortens-199")).toMatch(
      / 5500 {2}0000 {2}00$/,
    );
  });

  it("stored message equals the JS read path on the original, tail rows included (legend-lg45)", () => {
    let compared = 0;
    for (const fix of [fixA, fixB]) {
      for (const spec of fix.specs.filter((s) => s.name.startsWith("tail-"))) {
        const id = fix.ids.get(spec.name)!;
        const original = before.get(id)!.message as string;
        // The old write path masked with 0135's pattern first; 0135 changes
        // none of these rows, so the JS read path on the original is the oracle.
        expect(after0135.get(id)!.message, spec.name).toBe(original);
        expect(afterFirst.get(id)!.message, `${fix.label}/${spec.name}`).toBe(
          edcTransactionSchema.shape.message.parse(original),
        );
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(30);
  });

  it("a second 0143 run is a no-op: zero rows updated and every row unchanged", () => {
    let changedBy0143 = 0;
    for (const [id, row] of afterFirst) {
      if (JSON.stringify(row) !== JSON.stringify(after0135.get(id))) {
        changedBy0143 += 1;
      }
    }
    expect(changedBy0143).toBeGreaterThan(20);
    expect(firstRunUpdated).toBeGreaterThanOrEqual(changedBy0143);
    expect(secondRunUpdated).toBe(0);
    expect(JSON.stringify([...afterSecond])).toBe(
      JSON.stringify([...afterFirst]),
    );
  });

  it("no text column of any row holds a card-number-like run afterwards", () => {
    // Random uuid columns (id, idempotency_key) can hold digit runs split by
    // dashes by chance, so uuid-shaped values are skipped.
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const [id, row] of afterSecond) {
      for (const [col, value] of Object.entries(row)) {
        if (typeof value === "string" && !uuid.test(value)) {
          expect(cardLike(col, value), `${id} ${col}=${value}`).toBe(false);
          // No 0135 leftover next to a mask that shows more than the first 6
          // or last 4 digits.
          expect(LEFTOVER.test(value), `${id} ${col}=${value}`).toBe(false);
        }
      }
    }
  });

  it("every surviving masked_pan passes maskedPanSchema", () => {
    let seen = 0;
    for (const row of afterSecond.values()) {
      if (row.masked_pan === null) continue;
      seen += 1;
      expect(
        maskedPanSchema.safeParse(row.masked_pan).success,
        String(row.masked_pan),
      ).toBe(true);
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("forced row level security is on again after the migrations", async () => {
    const result = await owner.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'edc_transactions'`,
    );
    expect(result.rows).toEqual([{ enabled: true, forced: true }]);
  });

  // Run by hand without -1 (psql autocommit), statement by statement, and the
  // UPDATE fails. A BEFORE UPDATE trigger scoped to one marker row forces the
  // failure; vitest runs files one at a time, so it touches nothing else.
  async function withFailingMarker(
    run: (client: PoolClient, markerId: string) => Promise<void>,
  ) {
    const tag = randomUUID().replaceAll("-", "").slice(0, 12);
    const fn = `edc_scrub_probe_fail_${tag}`;
    const trigger = `edc_scrub_probe_${tag}`;
    const markerId = randomUUID();
    const markerCols = {
      rrn: PAN,
      message: `Kartu ${PAN_DOUBLE} ditolak`,
      masked_pan: PAN_TAB,
    };
    await owner.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN RAISE EXCEPTION 'scrub probe: forced failure'; END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON edc_transactions FOR EACH ROW
       WHEN (OLD.id = '${markerId}'::uuid) EXECUTE FUNCTION ${fn}()`,
    );
    const client = await owner.connect();
    try {
      await asTenant(fixA.tenantId, (c) =>
        insertRow(c, {
          id: markerId,
          tenantId: fixA.tenantId,
          outletId: fixA.outletId,
          terminalId: fixA.terminalId,
          label: "M",
          cols: markerCols,
        }),
      );
      await run(client, markerId);
      // The marker row is exactly as inserted.
      const marker = await asTenant(fixA.tenantId, (c) =>
        c.query(
          "SELECT rrn, message, masked_pan FROM edc_transactions WHERE id = $1",
          [markerId],
        ),
      );
      expect(marker.rows).toEqual([markerCols]);
    } finally {
      client.release();
      await owner.query(
        'ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY',
      );
      await owner.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON edc_transactions`,
      );
      await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await asTenant(fixA.tenantId, (c) =>
        c.query("DELETE FROM edc_transactions WHERE id = $1", [markerId]),
      );
    }
  }

  const runAutocommit = async (client: PoolClient, stmts: string[]) => {
    for (const statement of stmts) await client.query(statement);
  };

  it("0143 in autocommit with a failing UPDATE keeps FORCE RLS on and the row unchanged", async () => {
    await withFailingMarker(async (client) => {
      await expect(runAutocommit(client, statements0143)).rejects.toThrow(
        /scrub probe: forced failure/,
      );
      expect(await forcedRls()).toBe(true);
    });
  });

  it("0135 in autocommit with a failing UPDATE leaves FORCE RLS off (documents the 0135 bug)", async () => {
    await withFailingMarker(async (client) => {
      await expect(runAutocommit(client, statements0135)).rejects.toThrow(
        /scrub probe: forced failure/,
      );
      expect(await forcedRls()).toBe(false);
    });
    expect(await forcedRls()).toBe(true);
  });

  // Realistic deploy: the migration role owns the table but is NOT a superuser
  // and does NOT bypass RLS, and no tenant context is set. Everything runs in
  // one transaction that is rolled back, so ownership and data revert.
  it("under a NOSUPERUSER NOBYPASSRLS owner role the bare UPDATE fails and the 0143 file scrubs", async () => {
    const role = `scrub_probe_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const rowId = randomUUID();
    const setContext = (client: PoolClient, tenant: string, outlets: string) =>
      client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant, outlets],
      );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await setContext(client, fixA.tenantId, "*");
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      // legend_app carries USAGE on schema app (the RLS policy functions).
      await client.query(`GRANT legend_app TO ${role}`);
      await client.query(`GRANT ${role} TO CURRENT_USER`);
      await client.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
      await client.query(`ALTER TABLE edc_transactions OWNER TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);

      const who = await client.query(
        `SELECT r.rolsuper, r.rolbypassrls, c.relowner = r.oid AS owner_is_me
         FROM pg_roles r, pg_class c
         WHERE r.rolname = current_user AND c.oid = 'public.edc_transactions'::regclass`,
      );
      expect(who.rows).toEqual([
        { rolsuper: false, rolbypassrls: false, owner_is_me: true },
      ]);

      await insertRow(client, {
        id: rowId,
        tenantId: fixA.tenantId,
        outletId: fixA.outletId,
        terminalId: fixA.terminalId,
        label: "ROLE",
        cols: {
          card_type: PAN_TAB,
          rrn: PAN_DOUBLE,
          invoice_no: "000123",
          message: `Kartu ${PAN_DDASH} ditolak`,
          masked_pan: PAN_DOUBLE,
        },
      });

      // Migration time: no tenant context.
      await setContext(client, "", "");

      // The bare UPDATE (the DO block's UPDATE alone) hits FORCE RLS and fails.
      await client.query("SAVEPOINT bare_update");
      await expect(client.query(bareUpdate0143())).rejects.toThrow(
        /tenant context is required/,
      );
      await client.query("ROLLBACK TO SAVEPOINT bare_update");

      // The 0143 file as the migrator runs it succeeds and restores
      // lock_timeout.
      const lockBefore = await client.query("SHOW lock_timeout");
      const start = await updatedInTransaction(client);
      for (const statement of statements0143) await client.query(statement);
      expect(
        (await updatedInTransaction(client)) - start,
      ).toBeGreaterThanOrEqual(1);
      expect((await client.query("SHOW lock_timeout")).rows).toEqual(
        lockBefore.rows,
      );

      // FORCE is back on: reading without tenant context fails again.
      await client.query("SAVEPOINT forced_again");
      await expect(
        client.query("SELECT 1 FROM edc_transactions LIMIT 1"),
      ).rejects.toThrow(/tenant context is required/);
      await client.query("ROLLBACK TO SAVEPOINT forced_again");

      // With the tenant context back, the row is masked.
      await setContext(client, fixA.tenantId, "*");
      const scrubbed = await client.query(
        `SELECT card_type, rrn, message, masked_pan, invoice_no, status
         FROM edc_transactions WHERE id = $1`,
        [rowId],
      );
      expect(scrubbed.rows).toEqual([
        {
          card_type: "UNKNOWN",
          rrn: null,
          message: `Kartu ${SCRUBBED} ditolak`,
          masked_pan: MASKED_16,
          invoice_no: "000123",
          status: "approved",
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // Rolled back: the probe role and the ownership change are gone.
    const after = await owner.query(
      `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = $1)::int AS roles,
              pg_get_userbyid(c.relowner) <> $1 AS owner_restored
       FROM pg_class c WHERE c.oid = 'public.edc_transactions'::regclass`,
      [role],
    );
    expect(after.rows).toEqual([{ roles: 0, owner_restored: true }]);
  });
});
