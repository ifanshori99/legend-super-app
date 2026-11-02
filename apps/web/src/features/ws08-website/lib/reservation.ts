// Reservation entry form rules for the public website (PRD v1.7 §3.24
// "Reservasi & Member": a reservation form on the brand site).
//
// The full booking flow with table availability and DP handoff belongs to
// legend-xm4y (/reservasi); this page only collects a request and hands it to
// the venue's WhatsApp, so it states no policy the reservation contract does
// not own. Validation returns field keys, not sentences: the component maps
// them to the text catalog.

export type ReservationField = "name" | "date" | "time" | "pax";

export type ReservationRequest = {
  name: string;
  /** Business date, "YYYY-MM-DD". */
  date: string;
  /** "HH:MM", 24-hour clock in the outlet's time zone. */
  time: string;
  pax: number;
  notes: string;
};

/** What the form holds before validation: every value is a string. */
export type ReservationFormValues = {
  name: string;
  date: string;
  time: string;
  pax: string;
  notes: string;
};

export type ReservationValidation =
  | { ok: true; value: ReservationRequest }
  | { ok: false; errors: Partial<Record<ReservationField, true>> };

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PAX = 20;
const MAX_NOTES = 300;
const MAX_NAME = 80;

/**
 * Validates the entry form. `today` is the outlet's business date
 * ("YYYY-MM-DD"), so a guest cannot request a day that already passed; ISO
 * dates compare correctly as strings.
 */
export function validateReservationRequest(
  values: ReservationFormValues,
  today: string,
): ReservationValidation {
  const errors: Partial<Record<ReservationField, true>> = {};
  const name = values.name.trim();
  const date = values.date.trim();
  const time = values.time.trim();
  const notes = values.notes.trim();
  const pax = Number(values.pax);

  if (name.length < 2 || name.length > MAX_NAME) errors.name = true;
  if (!BUSINESS_DATE.test(date) || date < today) errors.date = true;
  if (!TIME_OF_DAY.test(time)) errors.time = true;
  if (!Number.isInteger(pax) || pax < 1 || pax > MAX_PAX) errors.pax = true;
  if (notes.length > MAX_NOTES) errors.notes = true;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, date, time, pax, notes } };
}

/**
 * `https://wa.me/<digits>?text=<message>` for a contract-valid WhatsApp number
 * (digits in international form, no `+`). Returns null for anything else, so a
 * bad contact hides the button instead of producing a broken link.
 */
export function buildWhatsAppUrl(
  phoneDigits: string,
  message: string,
): string | null {
  if (!/^[1-9][0-9]{7,14}$/.test(phoneDigits)) return null;
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
}
