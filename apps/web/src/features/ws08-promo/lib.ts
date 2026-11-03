// Pure helpers of the promo admin (bead legend-oadp; PRD v1.7 §3 F21, §3.21
// "Promo Engine"): form <-> contract body, validation, the plain-language
// summary, conflict warnings, the sequential stacking example (owner decision
// Q20) and ROI roll-ups. No React and no DOM at import time, and only bare
// package or relative `.ts` imports, so Node can load this file for tests.

import type { EndpointInput } from "@starter/shared/api";
import type {
  PromoChannel,
  PromoStackingPolicy,
  Promotion,
  PromotionRoi,
  PromotionStatus,
} from "@starter/shared/crm";
import type { createPromotion } from "@starter/shared/crm";
import {
  DEFAULT_BUSINESS_DAY_CLOCK,
  businessDateOf,
  businessDayRange,
} from "@starter/shared/core";
import { formatRupiah, type TranslateVars } from "@starter/shared/i18n";
import type { PromoKey, PromoT } from "./t.ts";

export type PromoBody = EndpointInput<typeof createPromotion>["body"];
/** Wire (input) shapes: plain numbers, unlike the branded stored rows. */
export type BodyBenefit = PromoBody["benefit"];
export type BodyCondition = PromoBody["conditions"][number];

export const PROMO_CHANNELS: readonly PromoChannel[] = [
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
  "website",
];
export const PROMO_STATUSES: readonly PromotionStatus[] = [
  "draft",
  "active",
  "paused",
  "ended",
];
export const BENEFIT_KINDS: readonly BodyBenefit["kind"][] = [
  "percent_off",
  "nominal_off",
  "free_items",
  "bundle_price",
  "facility_entitlement",
];
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Field → catalog key of the message that says how to fix it. */
export type ValidationErrors<Field extends string> = Partial<
  Record<Field, PromoKey>
>;

export function hasErrors<Field extends string>(
  errors: ValidationErrors<Field>,
): boolean {
  return Object.values(errors).some(Boolean);
}

export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

// ---- Numbers --------------------------------------------------------------

/**
 * A whole number from a text input; null when empty or not an integer.
 * Accepts plain digits ("12500", "-5") or id-ID thousands groups ("12.500").
 * Anything else ("12.5", "1e3", "0x10", "12,5") is rejected, so a decimal
 * typed into a rupiah field can never silently become a 10× larger amount.
 */
export function parseWholeNumber(input: string): number | null {
  const trimmed = input.trim();
  let digits: string;
  if (/^-?\d+$/.test(trimmed)) digits = trimmed;
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(trimmed))
    digits = trimmed.replace(/\./g, "");
  else return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** "10" or "12,5" → 1.000 / 1.250 basis points; null outside 0,01–100. */
export function parsePercentBp(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const bp = Math.round(value * 100);
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** 1.250 bp → "12,5%". */
export function formatPercentBp(bp: number): string {
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(bp / 100)}%`;
}

export function bpToInput(bp: number): string {
  return String(bp / 100).replace(".", ",");
}

// ---- Dates ----------------------------------------------------------------

// Promo validity is counted in outlet BUSINESS days (owner Q39: the day
// starts at the outlet cutoff, default 04:00), so "berakhir 31 Okt" still
// covers a 01:30 sale after a late 31 Okt close. The engine treats `endsAt`
// as exclusive (`!before(at, endsAt)` = ended), so the end instant is the
// cutoff that OPENS the next business day. The admin has no outlet picker,
// so the tenant default clock (Asia/Jakarta, 04:00) is used.
const CLOCK = DEFAULT_BUSINESS_DAY_CLOCK;

/**
 * Business date of a validity instant, as `<input type="date">` wants it.
 * An end instant is exclusive, so it is read 1 ms earlier: the cutoff that
 * opens 1 Nov is the end of business day 31 Okt.
 */
export function dateInputValue(
  iso: string,
  edge: "start" | "end" = "start",
): string {
  if (edge === "start") return businessDateOf(iso, CLOCK);
  return businessDateOf(new Date(Date.parse(iso) - 1), CLOCK);
}

/** `<input type="date">` value → opening / (exclusive) closing instant. */
export function isoFromDateInput(value: string, edge: "start" | "end"): string {
  const range = businessDayRange(value, CLOCK);
  return (edge === "start" ? range.start : range.end).toISOString();
}

const DAY_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** ISO instant or "2026-10-01" → "1 Okt 2026" (outlet business day). */
export function formatDateLabel(
  value: string,
  edge: "start" | "end" = "start",
): string {
  const day = value.length > 10 ? dateInputValue(value, edge) : value;
  const [year, month, date] = day.split("-").map(Number);
  return DAY_FORMAT.format(Date.UTC(year, month - 1, date));
}

function isValidDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

// ---- SHA-256 (promo codes are stored as a hash only, PRD §6.G) -------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Synchronous SHA-256 hex (works on insecure LAN origins without crypto.subtle). */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 9 + 63) >> 6) << 6) >>> 0;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** Codes are typed in any case; the engine hashes the uppercase form. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

export const isValidCode = (input: string) =>
  /^[A-Z0-9]{6,32}$/.test(normalizeCode(input));

// ---- Form -----------------------------------------------------------------

export type PromoForm = {
  name: string;
  description: string;
  status: PromotionStatus;
  startsOn: string;
  endsOn: string;
  voucherRequired: boolean;
  code: string;
  /** The promotion already carries a code hash (edit mode). */
  hasStoredCode: boolean;
  condMinSpend: boolean;
  minSpend: string;
  condChannel: boolean;
  channels: PromoChannel[];
  condMember: boolean;
  tierIds: string[];
  condTime: boolean;
  days: number[];
  timeStart: string;
  timeEnd: string;
  condItemQty: boolean;
  qtyItemIds: string[];
  minQuantity: string;
  condBundle: boolean;
  bundleItemIds: string[];
  benefitKind: BodyBenefit["kind"];
  percent: string;
  maxDiscount: string;
  nominal: string;
  freeItemIds: string[];
  freeQty: string;
  bundlePriceItemIds: string[];
  bundlePrice: string;
  facilityProductId: string;
  facilityQty: string;
  stackGroup: string;
  stackable: boolean;
  priority: string;
  quotaTotal: string;
  quotaPerCustomer: string;
  budget: string;
};
export type PromoField = keyof PromoForm | "general";

export function emptyPromoForm(today: string): PromoForm {
  return {
    name: "",
    description: "",
    status: "draft",
    startsOn: today,
    endsOn: "",
    voucherRequired: false,
    code: "",
    hasStoredCode: false,
    condMinSpend: false,
    minSpend: "",
    condChannel: false,
    channels: [],
    condMember: false,
    tierIds: [],
    condTime: false,
    days: [],
    timeStart: "15:00",
    timeEnd: "17:00",
    condItemQty: false,
    qtyItemIds: [],
    minQuantity: "2",
    condBundle: false,
    bundleItemIds: [],
    benefitKind: "percent_off",
    percent: "",
    maxDiscount: "",
    nominal: "",
    freeItemIds: [],
    freeQty: "1",
    bundlePriceItemIds: [],
    bundlePrice: "",
    facilityProductId: "",
    facilityQty: "1",
    stackGroup: "order_discount",
    stackable: true,
    priority: "10",
    quotaTotal: "",
    quotaPerCustomer: "",
    budget: "",
  };
}

export function promoFormFrom(promotion: Promotion): PromoForm {
  const form: PromoForm = {
    ...emptyPromoForm(dateInputValue(promotion.startsAt)),
    name: promotion.name,
    description: promotion.description,
    status: promotion.status,
    startsOn: dateInputValue(promotion.startsAt),
    endsOn: promotion.endsAt ? dateInputValue(promotion.endsAt, "end") : "",
    voucherRequired: promotion.voucherRequired,
    hasStoredCode: promotion.codeHash !== null,
    stackGroup: promotion.stackGroup,
    stackable: promotion.stackable,
    priority: String(promotion.priority),
    quotaTotal:
      promotion.quotaTotal === null ? "" : String(promotion.quotaTotal),
    quotaPerCustomer:
      promotion.quotaPerCustomer === null
        ? ""
        : String(promotion.quotaPerCustomer),
    budget: promotion.budgetIdr === null ? "" : String(promotion.budgetIdr),
  };
  for (const condition of promotion.conditions) {
    switch (condition.kind) {
      case "min_spend":
        form.condMinSpend = true;
        form.minSpend = String(condition.amountIdr);
        break;
      case "channel":
        form.condChannel = true;
        form.channels = [...condition.channels];
        break;
      case "member":
        form.condMember = true;
        form.tierIds = [...condition.tierIds];
        break;
      case "time_window":
        form.condTime = true;
        form.days = [...condition.daysOfWeek];
        form.timeStart = condition.start;
        form.timeEnd = condition.end;
        break;
      case "item_quantity":
        form.condItemQty = true;
        form.qtyItemIds = [...condition.menuItemIds];
        form.minQuantity = String(condition.minQuantity);
        break;
      case "bundle":
        form.condBundle = true;
        form.bundleItemIds = [...condition.menuItemIds];
        break;
    }
  }
  const benefit = promotion.benefit;
  form.benefitKind = benefit.kind;
  switch (benefit.kind) {
    case "percent_off":
      form.percent = bpToInput(benefit.percentBp);
      form.maxDiscount =
        benefit.maxDiscountIdr === null ? "" : String(benefit.maxDiscountIdr);
      break;
    case "nominal_off":
      form.nominal = String(benefit.amountIdr);
      break;
    case "free_items":
      form.freeItemIds = [...benefit.menuItemIds];
      form.freeQty = String(benefit.quantityPerMultiple);
      break;
    case "bundle_price":
      form.bundlePriceItemIds = [...benefit.menuItemIds];
      form.bundlePrice = String(benefit.bundlePriceIdr);
      break;
    case "facility_entitlement":
      form.facilityProductId = benefit.facilityProductId;
      form.facilityQty = String(benefit.quantity);
      break;
  }
  return form;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isUuid = (value: string) => UUID.test(value.trim());

export function validatePromoForm(
  form: PromoForm,
): ValidationErrors<PromoField> {
  const errors: ValidationErrors<PromoField> = {};
  if (form.name.trim() === "") errors.name = "errors.name";
  if (!isValidDateInput(form.startsOn)) errors.startsOn = "errors.startsOn";
  if (form.endsOn !== "") {
    if (!isValidDateInput(form.endsOn) || form.endsOn < form.startsOn)
      errors.endsOn = "errors.endsOn";
  }
  if (form.condMinSpend) {
    const amount = parseWholeNumber(form.minSpend);
    if (amount === null || amount <= 0) errors.minSpend = "errors.minSpend";
  }
  if (form.condChannel && form.channels.length === 0)
    errors.channels = "errors.channels";
  if (form.condTime) {
    if (form.days.length === 0) errors.days = "errors.days";
    if (!TIME.test(form.timeStart)) errors.timeStart = "errors.time";
    if (!TIME.test(form.timeEnd)) errors.timeEnd = "errors.time";
  }
  if (form.condItemQty) {
    if (form.qtyItemIds.length === 0) errors.qtyItemIds = "errors.qtyItems";
    const quantity = parseWholeNumber(form.minQuantity);
    if (quantity === null || quantity <= 0)
      errors.minQuantity = "errors.minQuantity";
  }
  if (form.condBundle && form.bundleItemIds.length < 2)
    errors.bundleItemIds = "errors.bundleItems";

  switch (form.benefitKind) {
    case "percent_off":
      if (parsePercentBp(form.percent) === null)
        errors.percent = "errors.percent";
      if (form.maxDiscount.trim() !== "") {
        const cap = parseWholeNumber(form.maxDiscount);
        if (cap === null || cap <= 0) errors.maxDiscount = "errors.maxDiscount";
      }
      break;
    case "nominal_off": {
      const amount = parseWholeNumber(form.nominal);
      if (amount === null || amount <= 0) errors.nominal = "errors.nominal";
      break;
    }
    case "free_items": {
      if (form.freeItemIds.length === 0)
        errors.freeItemIds = "errors.freeItems";
      const quantity = parseWholeNumber(form.freeQty);
      if (quantity === null || quantity <= 0) errors.freeQty = "errors.freeQty";
      if (!form.condItemQty) errors.condItemQty = "errors.freeNeedsBuy";
      break;
    }
    case "bundle_price": {
      if (form.bundlePriceItemIds.length < 2)
        errors.bundlePriceItemIds = "errors.bundleItems";
      const price = parseWholeNumber(form.bundlePrice);
      if (price === null || price < 0)
        errors.bundlePrice = "errors.bundlePrice";
      break;
    }
    case "facility_entitlement": {
      if (!isUuid(form.facilityProductId))
        errors.facilityProductId = "errors.facilityProductId";
      const quantity = parseWholeNumber(form.facilityQty);
      if (quantity === null || quantity <= 0)
        errors.facilityQty = "errors.facilityQty";
      break;
    }
  }

  for (const field of ["quotaTotal", "quotaPerCustomer"] as const) {
    if (form[field].trim() === "") continue;
    const value = parseWholeNumber(form[field]);
    if (value === null || value <= 0) errors[field] = "errors.quota";
  }
  if (form.budget.trim() !== "") {
    const budget = parseWholeNumber(form.budget);
    if (budget === null || budget < 0) errors.budget = "errors.budget";
  }
  if (!/^[a-z0-9_]{1,30}$/.test(form.stackGroup))
    errors.stackGroup = "errors.stackGroup";
  if (parseWholeNumber(form.priority) === null)
    errors.priority = "errors.priority";

  if (form.voucherRequired) {
    if (form.code.trim() !== "") {
      if (!isValidCode(form.code)) errors.code = "errors.code";
    } else if (!form.hasStoredCode) errors.code = "errors.codeRequired";
  }
  return errors;
}

function numberOrNull(input: string): number | null {
  return input.trim() === "" ? null : parseWholeNumber(input);
}

export function conditionsFrom(form: PromoForm): BodyCondition[] {
  const conditions: BodyCondition[] = [];
  if (form.condMinSpend)
    conditions.push({
      kind: "min_spend",
      amountIdr: parseWholeNumber(form.minSpend) ?? 0,
    });
  if (form.condChannel)
    conditions.push({ kind: "channel", channels: [...form.channels] });
  if (form.condMember)
    conditions.push({ kind: "member", tierIds: [...form.tierIds] });
  if (form.condTime)
    conditions.push({
      kind: "time_window",
      daysOfWeek: [...form.days].sort((a, b) => a - b),
      start: form.timeStart,
      end: form.timeEnd,
    });
  if (form.condItemQty)
    conditions.push({
      kind: "item_quantity",
      menuItemIds: [...form.qtyItemIds],
      minQuantity: parseWholeNumber(form.minQuantity) ?? 0,
    });
  if (form.condBundle)
    conditions.push({
      kind: "bundle",
      menuItemIds: [...form.bundleItemIds],
    });
  return conditions;
}

export function benefitFrom(form: PromoForm): BodyBenefit | null {
  switch (form.benefitKind) {
    case "percent_off": {
      const bp = parsePercentBp(form.percent);
      if (bp === null) return null;
      return {
        kind: "percent_off",
        percentBp: bp,
        maxDiscountIdr: numberOrNull(form.maxDiscount),
      };
    }
    case "nominal_off": {
      const amount = parseWholeNumber(form.nominal);
      return amount === null
        ? null
        : { kind: "nominal_off", amountIdr: amount };
    }
    case "free_items":
      return {
        kind: "free_items",
        menuItemIds: [...form.freeItemIds],
        quantityPerMultiple: parseWholeNumber(form.freeQty) ?? 0,
      };
    case "bundle_price":
      return {
        kind: "bundle_price",
        menuItemIds: [...form.bundlePriceItemIds],
        bundlePriceIdr: parseWholeNumber(form.bundlePrice) ?? 0,
      };
    case "facility_entitlement":
      return {
        kind: "facility_entitlement",
        facilityProductId: form.facilityProductId.trim(),
        quantity: parseWholeNumber(form.facilityQty) ?? 0,
      };
  }
}

/**
 * The contract body for a valid form (call validatePromoForm first). A typed
 * code is hashed here; an empty code keeps the stored hash (edit mode).
 */
export function promoBody(
  form: PromoForm,
  storedCodeHash: string | null,
): PromoBody | null {
  const benefit = benefitFrom(form);
  if (!benefit) return null;
  const codeHash = form.voucherRequired
    ? form.code.trim() !== ""
      ? sha256Hex(normalizeCode(form.code))
      : storedCodeHash
    : null;
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    status: form.status,
    codeHash,
    voucherRequired: form.voucherRequired,
    startsAt: isoFromDateInput(form.startsOn, "start"),
    endsAt: form.endsOn === "" ? null : isoFromDateInput(form.endsOn, "end"),
    conditions: conditionsFrom(form),
    benefit,
    stackGroup: form.stackGroup,
    stackable: form.stackable,
    priority: parseWholeNumber(form.priority) ?? 0,
    quotaTotal: numberOrNull(form.quotaTotal),
    quotaPerCustomer: numberOrNull(form.quotaPerCustomer),
    budgetIdr: numberOrNull(form.budget),
  } as PromoBody;
}

// ---- Plain-language summary -----------------------------------------------

export type SummaryContext = {
  t: PromoT;
  itemName: (id: string) => string | undefined;
  tierName: (id: string) => string | undefined;
};

function itemList(ids: readonly string[], ctx: SummaryContext): string {
  if (ids.length === 0) return ctx.t("promo.summary.anyItem");
  return ids
    .map((id) => ctx.itemName(id) ?? ctx.t("promo.summary.unknownItem"))
    .join(", ");
}

export function benefitSummary(
  benefit: BodyBenefit,
  ctx: SummaryContext,
): string {
  const { t } = ctx;
  switch (benefit.kind) {
    case "percent_off":
      return benefit.maxDiscountIdr === null
        ? t("promo.summary.benefit.percent", {
            percent: formatPercentBp(benefit.percentBp),
          })
        : t("promo.summary.benefit.percentCap", {
            percent: formatPercentBp(benefit.percentBp),
            max: formatRupiah(benefit.maxDiscountIdr),
          });
    case "nominal_off":
      return t("promo.summary.benefit.nominal", {
        amount: formatRupiah(benefit.amountIdr),
      });
    case "free_items":
      return t("promo.summary.benefit.free", {
        qty: benefit.quantityPerMultiple,
        items: itemList(benefit.menuItemIds, ctx),
      });
    case "bundle_price":
      return t("promo.summary.benefit.bundle", {
        price: formatRupiah(benefit.bundlePriceIdr),
        items: itemList(benefit.menuItemIds, ctx),
      });
    case "facility_entitlement":
      return t("promo.summary.benefit.facility", { qty: benefit.quantity });
  }
}

export function conditionSummary(
  condition: BodyCondition,
  ctx: SummaryContext,
): string {
  const { t } = ctx;
  switch (condition.kind) {
    case "min_spend":
      return t("promo.summary.cond.minSpend", {
        amount: formatRupiah(condition.amountIdr),
      });
    case "channel":
      return t("promo.summary.cond.channel", {
        channels: condition.channels
          .map((channel) => t(`promo.channel.${channel}`))
          .join(", "),
      });
    case "member":
      return condition.tierIds.length === 0
        ? t("promo.summary.cond.memberAny")
        : t("promo.summary.cond.memberTiers", {
            tiers: condition.tierIds
              .map((id) => ctx.tierName(id) ?? t("promo.summary.unknownTier"))
              .join(", "),
          });
    case "time_window":
      return t("promo.summary.cond.time", {
        days: daysLabel(condition.daysOfWeek, t),
        start: condition.start,
        end: condition.end,
      });
    case "item_quantity":
      return t("promo.summary.cond.itemQty", {
        qty: condition.minQuantity,
        items: itemList(condition.menuItemIds, ctx),
      });
    case "bundle":
      return t("promo.summary.cond.bundle", {
        items: itemList(condition.menuItemIds, ctx),
      });
  }
}

export function daysLabel(days: readonly number[], t: PromoT): string {
  if (days.length === 7) return t("promo.summary.allDays");
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => t(`promo.weekday.d${day}` as PromoKey))
    .join(", ");
}

/** The one-paragraph reading of a rule, shown beside the builder. */
export function summarizePromotion(
  body: Pick<
    PromoBody,
    | "benefit"
    | "conditions"
    | "startsAt"
    | "endsAt"
    | "quotaTotal"
    | "quotaPerCustomer"
    | "budgetIdr"
    | "voucherRequired"
    | "stackable"
    | "stackGroup"
  >,
  ctx: SummaryContext,
): string[] {
  const { t } = ctx;
  const benefit = benefitSummary(body.benefit, ctx);
  const conditions = body.conditions.map((c) => conditionSummary(c, ctx));
  const lines = [
    conditions.length === 0
      ? t("promo.summary.sentence", { benefit })
      : t("promo.summary.sentenceIf", {
          benefit,
          conditions: conditions.join(", "),
        }),
  ];
  lines.push(
    body.endsAt === null
      ? t("promo.summary.validityOpen", {
          from: formatDateLabel(body.startsAt),
        })
      : t("promo.summary.validity", {
          from: formatDateLabel(body.startsAt),
          to: formatDateLabel(body.endsAt, "end"),
        }),
  );
  lines.push(...ruleNotes(body, ctx));
  const limits: string[] = [];
  if (body.quotaTotal !== null)
    limits.push(t("promo.summary.quotaTotal", { total: body.quotaTotal }));
  if (body.quotaPerCustomer !== null)
    limits.push(
      t("promo.summary.quotaPerCustomer", { count: body.quotaPerCustomer }),
    );
  if (body.budgetIdr !== null)
    limits.push(
      t("promo.summary.budget", { amount: formatRupiah(body.budgetIdr) }),
    );
  if (limits.length > 0)
    lines.push(t("promo.summary.limits", { parts: limits.join(", ") }));
  if (body.voucherRequired) lines.push(t("promo.summary.voucher"));
  lines.push(
    body.stackable
      ? t("promo.summary.stackGroup", { group: body.stackGroup })
      : t("promo.summary.stackAlone"),
  );
  return lines;
}

/**
 * Owner rules the engine applies that the rule itself does not spell out
 * (PRD §3.21; owner Q40, Q41; legend-w3zf), so the summary never promises
 * more than the engine gives.
 */
export function ruleNotes(
  body: Pick<PromoBody, "benefit" | "conditions">,
  ctx: SummaryContext,
): string[] {
  const { t } = ctx;
  const notes: string[] = [];
  const benefit = body.benefit;
  if (benefit.kind === "free_items") {
    const buy = body.conditions.find((c) => c.kind === "item_quantity");
    if (
      buy?.kind === "item_quantity" &&
      benefit.menuItemIds.some((id) => buy.menuItemIds.includes(id))
    )
      // Same rule as the engine's freeItemBenefit: a free unit drawn from the
      // buy items is not a paid unit, so one multiple needs X + Y units.
      notes.push(
        t("promo.summary.freeSameItem", {
          units: buy.minQuantity + benefit.quantityPerMultiple,
          paid: buy.minQuantity,
          free: benefit.quantityPerMultiple,
        }),
      );
    notes.push(t("promo.summary.freeCheapest"));
  }
  const hasMinSpend = body.conditions.some((c) => c.kind === "min_spend");
  if (hasMinSpend && benefit.kind === "facility_entitlement")
    notes.push(t("promo.summary.facilityDaily"));
  if (
    body.conditions.some(
      (c) =>
        c.kind === "min_spend" ||
        c.kind === "item_quantity" ||
        c.kind === "bundle",
    )
  )
    notes.push(t("promo.summary.refundWithdraws"));
  return notes;
}

/** Draft body from a possibly incomplete form, for the live summary. */
export function previewBody(form: PromoForm): PromoBody | null {
  const benefit = benefitFrom(form);
  if (!benefit || !isValidDateInput(form.startsOn)) return null;
  return promoBody(form, null);
}

// ---- Conflict warnings -----------------------------------------------------

export type ConflictLevel = "danger" | "warning" | "info";
export type Conflict = {
  id: string;
  level: ConflictLevel;
  key: PromoKey;
  vars?: TranslateVars;
};

const FAR_FUTURE = Number.POSITIVE_INFINITY;

function windowOf(p: { startsAt: string; endsAt: string | null }) {
  return [
    Date.parse(p.startsAt),
    p.endsAt === null ? FAR_FUTURE : Date.parse(p.endsAt),
  ] as const;
}

function channelsOf(conditions: readonly BodyCondition[]) {
  const condition = conditions.find((c) => c.kind === "channel");
  return condition?.kind === "channel" ? condition.channels : null;
}

/** Another active promotion that can fire on the same bill as `body`. */
export function rivalPromotions(
  body: Pick<
    PromoBody,
    "startsAt" | "endsAt" | "conditions" | "voucherRequired"
  >,
  others: readonly Promotion[],
  selfId: string | null,
): Promotion[] {
  if (body.voucherRequired) return [];
  const [start, end] = windowOf(body);
  const mine = channelsOf(body.conditions);
  return others.filter((other) => {
    if (
      other.id === selfId ||
      other.status !== "active" ||
      other.voucherRequired
    )
      return false;
    const [otherStart, otherEnd] = windowOf(other);
    if (!(start < otherEnd && otherStart < end)) return false;
    const theirs = channelsOf(other.conditions);
    if (mine === null || theirs === null) return true;
    return mine.some((channel) => theirs.includes(channel));
  });
}

function names(promotions: readonly Promotion[]): string {
  const shown = promotions.slice(0, 3).map((p) => p.name);
  const rest = promotions.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

export function detectConflicts(input: {
  body: PromoBody;
  selfId: string | null;
  spentIdr: number;
  hasStoredCode: boolean;
  others: readonly Promotion[];
  policy: PromoStackingPolicy;
  now: number;
}): Conflict[] {
  const { body, others, policy } = input;
  const out: Conflict[] = [];
  const benefit = body.benefit;
  const needsCode = body.voucherRequired && body.codeHash === null;
  if (needsCode)
    out.push({
      id: "voucherWithoutCode",
      level: "danger",
      key: "conflict.voucherWithoutCode",
    });
  if (
    benefit.kind === "free_items" &&
    !body.conditions.some((c) => c.kind === "item_quantity")
  )
    out.push({
      id: "freeNeedsBuy",
      level: "danger",
      key: "conflict.freeNeedsBuy",
    });
  if (benefit.kind === "bundle_price" && benefit.menuItemIds.length < 2)
    out.push({
      id: "bundleNeedsItems",
      level: "danger",
      key: "conflict.bundleNeedsItems",
    });
  if (
    benefit.kind === "percent_off" &&
    benefit.percentBp >= 5_000 &&
    benefit.maxDiscountIdr === null
  )
    out.push({
      id: "highPercent",
      level: "warning",
      key: "conflict.highPercent",
      vars: { percent: formatPercentBp(benefit.percentBp) },
    });
  if (body.budgetIdr !== null) {
    if (body.budgetIdr < input.spentIdr)
      out.push({
        id: "budgetBelowSpent",
        level: "danger",
        key: "conflict.budgetBelowSpent",
        vars: { spent: formatRupiah(input.spentIdr) },
      });
    else if (body.budgetIdr > 0 && input.spentIdr / body.budgetIdr >= 0.9)
      out.push({
        id: "budgetLow",
        level: "warning",
        key: "conflict.budgetLow",
        vars: {
          budget: formatRupiah(body.budgetIdr),
          percent: Math.round((input.spentIdr / body.budgetIdr) * 100),
        },
      });
  }
  if (
    body.quotaTotal !== null &&
    body.quotaPerCustomer !== null &&
    body.quotaPerCustomer > body.quotaTotal
  )
    out.push({ id: "quotaOrder", level: "info", key: "conflict.quotaOrder" });
  if (
    body.status === "active" &&
    body.endsAt !== null &&
    Date.parse(body.endsAt) < input.now
  )
    out.push({
      id: "endedWindow",
      level: "warning",
      key: "conflict.endedWindow",
    });
  if (body.quotaTotal === null && body.budgetIdr === null)
    out.push({
      id: "noBudgetNoQuota",
      level: "info",
      key: "conflict.noBudgetNoQuota",
    });

  if (body.status !== "ended") {
    const rivals = rivalPromotions(body, others, input.selfId);
    if (rivals.length > 0) {
      if (policy.mode === "exclusive")
        out.push({
          id: "policyExclusive",
          level: "info",
          key: "conflict.policyExclusive",
          vars: { names: names(rivals) },
        });
      else {
        if (!body.stackable)
          out.push({
            id: "notStackable",
            level: "warning",
            key: "conflict.notStackable",
          });
        const sameGroup = rivals.filter(
          (r) => r.stackGroup === body.stackGroup,
        );
        if (sameGroup.length > 0 && !policy.allowSameGroup)
          out.push({
            id: "sameGroup",
            level: "warning",
            key: "conflict.sameGroup",
            vars: { group: body.stackGroup, names: names(sameGroup) },
          });
        const samePriority = sameGroup.filter(
          (r) => r.priority === body.priority,
        );
        if (samePriority.length > 0)
          out.push({
            id: "samePriority",
            level: "warning",
            key: "conflict.samePriority",
            vars: { priority: body.priority, names: names(samePriority) },
          });
        if (rivals.length + 1 > policy.maxStacked)
          out.push({
            id: "overStack",
            level: "info",
            key: "conflict.overStack",
            vars: { count: rivals.length + 1, max: policy.maxStacked },
          });
      }
    }
  }
  return out;
}

// ---- Stacking example (owner decision Q20) --------------------------------

export type StackStep = {
  percentBp: number;
  baseIdr: number;
  discountIdr: number;
};

/**
 * Sequential percentages: each one applies to what is left after the ones
 * before it. 10% then 20% of Rp100.000 = 10.000 + 18.000 = Rp28.000.
 */
export function sequentialStack(
  subtotalIdr: number,
  percentsBp: readonly number[],
): { steps: StackStep[]; totalIdr: number; payIdr: number } {
  let remaining = subtotalIdr;
  const steps: StackStep[] = [];
  for (const percentBp of percentsBp) {
    const discountIdr = Math.round((remaining * percentBp) / 10_000);
    steps.push({ percentBp, baseIdr: remaining, discountIdr });
    remaining -= discountIdr;
  }
  const totalIdr = subtotalIdr - remaining;
  return { steps, totalIdr, payIdr: remaining };
}

// ---- ROI -------------------------------------------------------------------

export function totalRoi(rows: readonly PromotionRoi[]) {
  const cost = rows.reduce((sum, row) => sum + row.discountCostIdr, 0);
  const revenue = rows.reduce((sum, row) => sum + row.revenueIdr, 0);
  const net = rows.reduce((sum, row) => sum + row.netMarginIdr, 0);
  return {
    cost,
    revenue,
    net,
    transactions: rows.reduce((sum, row) => sum + row.transactions, 0),
    roiBp: cost > 0 ? Math.round((net / cost) * 10_000) : null,
  };
}

/** Budget used as a whole percent, capped for the bar. */
export function budgetPercent(
  spent: number,
  budget: number | null,
): number | null {
  if (budget === null) return null;
  if (budget === 0) return spent > 0 ? 100 : 0;
  return Math.min(100, Math.round((spent / budget) * 100));
}
