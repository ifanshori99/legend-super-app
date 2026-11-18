// Payables and receivables (PRD v1.7 §3.19 "Utang & Piutang [P0] — Kartu utang
// supplier dengan umur utang, serta piutang untuk event dan corporate
// account"). Supplier invoices are recorded by WS-06 purchasing
// (`supplier_invoice.recorded`); this contract owns the open-item view and the
// aging report. Aging bucket limits are tenant data (default 30/60/90 in the
// fixtures), not code.

import { z } from "zod";
import {
  businessDateSchema,
  idrSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { legalEntityIdSchema } from "./ids.ts";
import { daysBetween } from "./period-key.ts";

export const openItemKindSchema = z.enum(["payable", "receivable"]);
export type OpenItemKind = z.infer<typeof openItemKindSchema>;

export const counterpartyTypeSchema = z.enum([
  "supplier",
  "corporate_account",
  "event_customer",
  // Employee PPh 21 receivable (legend-itph; account 1204).
  "employee",
]);

/** One unpaid (or partly paid) invoice: kartu utang / kartu piutang row. */
export const openItemSchema = z
  .strictObject({
    /** Source document id (supplier invoice, AR invoice). */
    id: uuidSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    kind: openItemKindSchema,
    counterpartyType: counterpartyTypeSchema,
    counterpartyId: uuidSchema,
    counterpartyName: z.string().trim().min(1).max(150),
    documentNumber: z.string().trim().min(1).max(60),
    documentDate: businessDateSchema,
    dueOn: businessDateSchema,
    originalIdr: idrSchema.refine((v) => v > 0, "Amount must be > 0"),
    settledIdr: idrSchema.refine((v) => v >= 0, "Amount must be >= 0"),
    outstandingIdr: idrSchema.refine((v) => v >= 0, "Amount must be >= 0"),
  })
  .superRefine((item, ctx) => {
    if (item.originalIdr - item.settledIdr !== item.outstandingIdr)
      ctx.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message: "outstanding = original - settled",
      });
    if (item.dueOn < item.documentDate)
      ctx.addIssue({
        code: "custom",
        path: ["dueOn"],
        message: "dueOn must not be before documentDate",
      });
  });
export type OpenItem = z.infer<typeof openItemSchema>;

/**
 * One row of the open-item list behind an aging cell: an invoice that still
 * has money outstanding (outstanding > 0), as of the requested date. Carries
 * no tenant id: the tenant is the caller's.
 */
export const openItemListRowSchema = z
  .strictObject({
    id: uuidSchema,
    outletId: outletIdSchema.nullable(),
    counterpartyType: counterpartyTypeSchema,
    counterpartyId: uuidSchema,
    counterpartyName: z.string().trim().min(1).max(150),
    documentNumber: z.string().trim().min(1).max(60),
    documentDate: businessDateSchema,
    dueOn: businessDateSchema,
    originalIdr: idrSchema.refine((v) => v > 0, "Amount must be > 0"),
    settledIdr: idrSchema.refine((v) => v >= 0, "Amount must be >= 0"),
    outstandingIdr: idrSchema.refine((v) => v > 0, "Amount must be > 0"),
  })
  .superRefine((item, ctx) => {
    if (item.originalIdr - item.settledIdr !== item.outstandingIdr)
      ctx.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message: "outstanding = original - settled",
      });
    if (item.dueOn < item.documentDate)
      ctx.addIssue({
        code: "custom",
        path: ["dueOn"],
        message: "dueOn must not be before documentDate",
      });
  });
export type OpenItemListRow = z.infer<typeof openItemListRowSchema>;

/** Ascending day limits of the overdue buckets, e.g. [30, 60, 90] (tenant data). */
export const agingBucketLimitsSchema = z
  .array(z.number().int().min(1).max(3650))
  .min(1)
  .max(8)
  .refine(
    (limits) => limits.every((limit, i) => i === 0 || limit > limits[i - 1]),
    "Bucket limits must be strictly ascending",
  );

/**
 * Bucket labels for limits [30, 60, 90]: current, 1-30, 31-60, 61-90, >90.
 * "current" = not yet due at `asOf`.
 */
export function agingBucketLabels(limits: readonly number[]): string[] {
  const labels = ["current"];
  limits.forEach((limit, i) =>
    labels.push(`${i === 0 ? 1 : limits[i - 1] + 1}-${limit}`),
  );
  labels.push(`>${limits[limits.length - 1]}`);
  return labels;
}

/** Index into agingBucketLabels for an item due on `dueOn`. */
export function agingBucketIndex(
  dueOn: string,
  asOf: string,
  limits: readonly number[],
): number {
  const overdue = daysBetween(dueOn, asOf);
  if (overdue <= 0) return 0;
  const index = limits.findIndex((limit) => overdue <= limit);
  return index === -1 ? limits.length + 1 : index + 1;
}

export const agingRowSchema = z.strictObject({
  counterpartyId: uuidSchema,
  counterpartyName: z.string(),
  buckets: z.array(idrSchema),
  totalIdr: idrSchema,
});
export const agingReportSchema = z
  .strictObject({
    kind: openItemKindSchema,
    asOf: businessDateSchema,
    bucketLabels: z.array(z.string()).min(2),
    rows: z.array(agingRowSchema),
    bucketTotals: z.array(idrSchema),
    totalIdr: idrSchema,
  })
  .superRefine((report, ctx) => {
    const width = report.bucketLabels.length;
    const sum = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0);
    for (const row of [
      ...report.rows,
      { buckets: report.bucketTotals, totalIdr: report.totalIdr },
    ])
      if (row.buckets.length !== width || sum(row.buckets) !== row.totalIdr)
        ctx.addIssue({
          code: "custom",
          message: "Bucket amounts must add up to the total",
        });
    if (sum(report.rows.map((row) => row.totalIdr)) !== report.totalIdr)
      ctx.addIssue({
        code: "custom",
        message: "Row totals must add up to the report total",
      });
  });
export type AgingReport = z.infer<typeof agingReportSchema>;

/** Aging report of outstanding items of one kind; sums are exact. */
export function buildAgingReport(
  items: readonly OpenItem[],
  kind: OpenItemKind,
  asOf: string,
  limits: readonly number[],
): AgingReport {
  const labels = agingBucketLabels(limits);
  const zero = () => labels.map(() => 0);
  const rows = new Map<string, { name: string; buckets: number[] }>();
  for (const item of items) {
    if (item.kind !== kind || item.outstandingIdr === 0) continue;
    const row = rows.get(item.counterpartyId) ?? {
      name: item.counterpartyName,
      buckets: zero(),
    };
    row.buckets[agingBucketIndex(item.dueOn, asOf, limits)] +=
      item.outstandingIdr;
    rows.set(item.counterpartyId, row);
  }
  const reportRows = [...rows.entries()]
    .map(([counterpartyId, row]) => ({
      counterpartyId,
      counterpartyName: row.name,
      buckets: row.buckets as Idr[],
      totalIdr: row.buckets.reduce((sum, value) => sum + value, 0) as Idr,
    }))
    .sort(
      (a, b) =>
        b.totalIdr - a.totalIdr ||
        a.counterpartyName.localeCompare(b.counterpartyName),
    );
  const bucketTotals = zero();
  for (const row of reportRows)
    row.buckets.forEach((value, i) => (bucketTotals[i] += value));
  return agingReportSchema.parse({
    kind,
    asOf,
    bucketLabels: labels,
    rows: reportRows,
    bucketTotals,
    totalIdr: bucketTotals.reduce((sum, value) => sum + value, 0),
  });
}
