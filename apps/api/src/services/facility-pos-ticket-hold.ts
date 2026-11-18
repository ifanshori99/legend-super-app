// A POS ticket hold must not lapse while money is on its bill (936 part D).
// The sweeper (`releaseExpiredSlotHolds`) and the lapsed-hold release inside
// `holdFacilitySlot` skip a `pending_payment` ticket whose pending POS line has
// a captured or authorized tender on its order, or a card sale already sent to
// the terminal (pending / unknown / approved / needing reconciliation, matched
// by the order number): a guest who paid (QRIS landing late, EDC approval)
// keeps the slot until the cashier completes the bill, and the bill is never
// left paid with a cancelled ticket. A hold with no money in flight lapses as
// before. The check races with a tender that starts at the same moment, so the
// lapsed-hold release (`cancelLapsedPosAwareHold` in facility-slots.service.ts)
// locks the ticket row and re-reads this predicate in a NEW statement; the
// tender start (`assertPosTicketsIssuable`) locks the same ticket row. Kept in its own module because the slots service and
// the POS ticket service import each other's neighbours.
import { sql, type SQL } from "drizzle-orm";
import { accessTickets } from "../db/schema/facility.ts";

export const posTicketPaymentNotInFlightSql: SQL = sql`NOT EXISTS (
  SELECT 1
    FROM facility_ticket_pos_lines l
    JOIN pos_order_tenders t
      ON t.tenant_id = l.tenant_id AND t.order_id = l.order_id
   WHERE l.tenant_id = ${accessTickets.tenantId}
     AND l.access_ticket_id = ${accessTickets.id}
     AND l.status = 'pending'
     AND t.status IN ('captured', 'authorized')
) AND NOT EXISTS (
  SELECT 1
    FROM facility_ticket_pos_lines l
    JOIN orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN edc_transactions e
      ON e.tenant_id = o.tenant_id AND e.outlet_id = o.outlet_id
     AND e.reference = o.number
   WHERE l.tenant_id = ${accessTickets.tenantId}
     AND l.access_ticket_id = ${accessTickets.id}
     AND l.status = 'pending'
     AND e.type = 'sale'
     AND (e.status IN ('pending', 'unknown', 'approved')
          OR e.needs_reconciliation = true)
)`;
