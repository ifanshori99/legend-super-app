// Date and quantity formatting for the employee payslip, kasbon and
// reimbursement screens (bead legend-23nc). No React and no device time zone:
// business dates are calendar dates, so they are formatted at noon UTC and the
// server render matches the browser render (docs/frontend.md "Server rendering
// with data"). A fixed `id-ID` format comes from @starter/shared/i18n.

import { formatNumber } from "@starter/shared/i18n";

const BUSINESS_DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "26 Sep 2026" from a business date; the catalog adds the period dash. */
export function formatBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return businessDate;
  // Noon UTC so the calendar date cannot slip across a zone boundary.
  return BUSINESS_DATE.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/**
 * Payslip line quantity (decimal4 string): "3.5000" → "3,5". Whole values stay
 * whole ("25" → "25"), so a meal-day count never renders as "25,00".
 */
export function formatQuantity(quantity: string | null): string | null {
  if (quantity === null) return null;
  const value = Number(quantity);
  if (!Number.isFinite(value)) return quantity;
  return formatNumber(value, {
    fractionDigits: Number.isInteger(value) ? 0 : 2,
  });
}
