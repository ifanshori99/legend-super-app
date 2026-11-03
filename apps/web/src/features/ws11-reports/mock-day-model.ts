// Single deterministic day model behind every WS-11 report mock: the report
// viewer's runs (features/ws11-reports/mock.ts) and the report builder's
// previews (features/ws11-report-builder/mock-preview.ts) both import this
// module, so a preview cell and a viewer cell are the same number by
// construction (DASH-02; tests/ws11-report-builder.test.mjs compares their
// generated output run by run).
//
// The model is anchored on the owner dashboard's fixture numbers for the open
// business day 1 Nov 2026 (net sales Rp 7.420.000, 96 transactions, 148
// guests, the four channels): BASE_DAY carries those atoms, WEEKDAY_FACTOR
// spreads them over Monday .. Sunday, and the shareholder's closed month
// scales the whole period to the books (net sales Rp 412.800.000, SH-01).
// Figures are mock-only, plausible Cafe Legend numbers; nothing is predicted.
//
// Loaded in Node with type stripping: bare package imports and relative `.ts`
// paths only, no `@/` alias.
import { cafeLegendManagementLayoutFixture } from "@starter/shared/dashboard";

/** The atoms every report metric is computed from. */
export type Atoms = {
  net: number;
  gross: number;
  discount: number;
  refund: number;
  tx: number;
  pax: number;
  qty: number;
  voided: number;
};

export type AtomKey = keyof Atoms;

/** Every atom, in the order the model fills them. */
export const ATOM_KEYS: readonly AtomKey[] = [
  "net",
  "gross",
  "discount",
  "refund",
  "tx",
  "pax",
  "qty",
  "voided",
];

/** A half-open-free inclusive range of business dates (`YYYY-MM-DD`). */
export type DateRange = { startDate: string; endDate: string };

/** The owner's current open business day. */
export const BUSINESS_DATE = cafeLegendManagementLayoutFixture.businessDate;
export const MONTH_START = `${BUSINESS_DATE.slice(0, 7)}-01`;

/** SH-01: the last full month's net sales tie to the books. */
export const CLOSED_MONTH_NET_SALES = 412_800_000;

/** The last full month before the open business day. */
export const LAST_MONTH: { start: string; end: string } = (() => {
  const end = new Date(`${MONTH_START}T00:00:00Z`);
  end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  return { start: `${last.slice(0, 8)}01`, end: last };
})();

/** The open business day (a Sunday), anchored on the owner board's figures. */
export const BASE_DAY: Atoms = {
  net: 7_420_000,
  gross: 7_920_000,
  discount: 380_000,
  refund: 120_000,
  tx: 96,
  pax: 148,
  qty: 214,
  voided: 95_000,
};

/** Monday .. Sunday; the business day (Sunday) is 1. */
export const WEEKDAY_FACTOR = [0.78, 0.82, 0.85, 0.9, 1.15, 1.3, 1] as const;

export function zeroAtoms(): Atoms {
  return {
    net: 0,
    gross: 0,
    discount: 0,
    refund: 0,
    tx: 0,
    pax: 0,
    qty: 0,
    voided: 0,
  };
}

export function eachDay(range: DateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.startDate}T00:00:00Z`);
  const end = new Date(`${range.endDate}T00:00:00Z`);
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** ISO weekday index 0 (Monday) .. 6 (Sunday). */
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** The atoms of one business day. */
export function dayAtoms(day: string): Atoms {
  const factor = WEEKDAY_FACTOR[weekdayIndex(day)] ?? 1;
  const atoms = zeroAtoms();
  for (const key of ATOM_KEYS) atoms[key] = Math.round(BASE_DAY[key] * factor);
  return atoms;
}

/** The summed atoms of a range, with the closed-month tie to the books. */
export function periodAtoms(range: DateRange): Atoms {
  const total = zeroAtoms();
  for (const day of eachDay(range)) {
    const atoms = dayAtoms(day);
    for (const key of ATOM_KEYS) total[key] += atoms[key];
  }
  // The last full month is the shareholder's closed month: its sales tie to
  // the books (SH-01), so every figure scales together.
  if (
    range.startDate === LAST_MONTH.start &&
    range.endDate === LAST_MONTH.end
  ) {
    const scale = CLOSED_MONTH_NET_SALES / total.net;
    for (const key of ATOM_KEYS) total[key] = Math.round(total[key] * scale);
  }
  return total;
}

/** Largest-remainder split, so the parts always add up to the total. */
export function distribute(
  total: number,
  weights: readonly number[],
): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

export type SplitSpec = {
  values: readonly string[];
  /** Weights per atom; `net` is the fallback for atoms without their own. */
  weights: Partial<Record<AtomKey, readonly number[]>> & {
    net: readonly number[];
  };
};

/**
 * The outlet split names its single value, so the caller passes either the
 * outlet name (viewer rows) or the outlet id (builder query).
 */
export function outletSplit(value: string): SplitSpec {
  return { values: [value], weights: { net: [1] } };
}

/** The fixed splits, in the order the mock model breaks a period down. */
export const SPLITS: Readonly<Record<string, SplitSpec>> = {
  channel: {
    values: ["qr", "pos", "gofood", "grabfood"],
    weights: {
      net: [4_150_000, 1_980_000, 780_000, 510_000],
      tx: [52, 28, 10, 6],
      pax: [92, 34, 14, 8],
    },
  },
  hour: {
    values: [
      "08",
      "09",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
    ],
    weights: { net: [2, 3, 5, 8, 12, 11, 7, 6, 7, 9, 12, 10, 6, 3] },
  },
  menu_item: {
    values: [
      "Kopi Susu Aren",
      "Nasi Goreng Kampung",
      "Ayam Geprek",
      "Matcha Latte",
      "Croissant Mentega",
      "Es Teh Lemon",
      "Pisang Goreng Keju",
      "Mie Goreng Seafood",
      "Americano",
      "Roti Bakar Coklat",
    ],
    weights: {
      net: [
        1_260_000, 1_085_000, 945_000, 720_000, 525_000, 640_000, 520_000,
        480_000, 760_000, 485_000,
      ],
      qty: [42, 31, 27, 24, 21, 18, 14, 12, 16, 9],
    },
  },
  menu_category: {
    values: ["Kopi", "Makanan berat", "Nonkopi", "Pastry dan camilan"],
    weights: {
      net: [2_900_000, 2_700_000, 1_120_000, 700_000],
      qty: [78, 62, 41, 33],
    },
  },
  employee: {
    values: ["Rani", "Dimas", "Putri", "Fajar"],
    weights: {
      net: [2_300_000, 2_050_000, 1_760_000, 1_310_000],
      tx: [30, 26, 24, 16],
      voided: [40_000, 25_000, 20_000, 10_000],
    },
  },
  payment_method: {
    values: ["qris", "cash", "debit", "ewallet"],
    weights: {
      net: [3_300_000, 2_200_000, 1_120_000, 800_000],
      tx: [44, 26, 16, 10],
      refund: [60_000, 30_000, 20_000, 10_000],
    },
  },
  promo: {
    values: ["Promo Gajian", "Voucher Member", "Diskon Jam Santai"],
    weights: { net: [200_000, 110_000, 70_000] },
  },
};

/** Single-day open business day: the café has only served until 11.40 WIB. */
export const OPEN_DAY_HOURS = ["08", "09", "10", "11"] as const;
export const OPEN_DAY_HOUR_WEIGHTS = [2, 3, 5, 8] as const;

/**
 * The fixed split for a dimension, or `null` when the model cannot break it
 * down. `outlet` is handled by `outletSplit`, because its value is the
 * caller's label.
 */
export function splitSpecFor(key: string, range: DateRange): SplitSpec | null {
  const spec = SPLITS[key];
  if (spec === undefined) return null;
  if (
    key === "hour" &&
    range.startDate === BUSINESS_DATE &&
    range.endDate === BUSINESS_DATE
  )
    return { values: OPEN_DAY_HOURS, weights: { net: OPEN_DAY_HOUR_WEIGHTS } };
  return spec;
}
