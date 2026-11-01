import { z } from "../core/index.ts";
import { eventNameSchema } from "./schemas.ts";

/** Proposed v1 names, to be owned and refined by each workstream. Payload
 * references are stable identifiers, not a claim the domain schemas exist yet. */
export const eventCatalogEntrySchema = z
  .object({
    name: eventNameSchema,
    aggregateType: z.string().min(1),
    version: z.number().int().positive().safe(),
    payloadSchemaRef: z.string().min(1).max(255),
    workstream: z.string().regex(/^WS-\d{2}$/),
  })
  .strict()
  .refine((entry) => entry.name.split(".")[0] === entry.aggregateType, {
    path: ["name"],
    message: "Event name must match aggregate type",
  });
export type EventCatalogEntry = z.infer<typeof eventCatalogEntrySchema>;
const namesByWorkstream = {
  "WS-01":
    "login_challenge.created login_challenge.completed identity.linked session.created action_request.created action_request.approved action_request.executed role.updated employee_access.updated",
  "WS-02":
    "device.registered device.revoked print_job.created sync.batch_applied",
  "WS-03":
    "menu_item.updated price_list.updated table_session.opened table_session.joined cart.updated menu.updated item.sold_out item.restored",
  "WS-04":
    "order.submitted order.paid order.voided order.refunded kitchen_ticket.created kitchen_ticket.updated cashier_shift.opened cashier_shift.closed",
  "WS-05":
    "payment_intent.created payment.paid payment.failed payment.refunded settlement.reconciled notification.created notification.sent payment.expired settlement.imported",
  "WS-06":
    "stock.deducted stock.adjusted stock.transferred recipe.updated production.completed purchase_order.created goods_receipt.recorded supplier_invoice.recorded stock.moved stock.critical recipe.cost_changed",
  "WS-07":
    "journal.posted fiscal_period.closed fiscal_period.reopened distribution.completed",
  "WS-08":
    "customer.created loyalty_points.earned loyalty_points.expired loyalty_tier.evaluated reservation.created reservation.cancelled delivery_order.received",
  "WS-09":
    "facility_entitlement.issued facility_entitlement.expired access_ticket.issued access_event.recorded facility_session.started facility_session.ended cleaning_task.created subscription.billed wifi_quota.updated",
  "WS-10":
    "employee.updated attendance.recorded payroll_run.completed payslip.created",
  "WS-11": "metrics.aggregated report.generated",
  "WS-12": "ai_job.completed tool_request.approved",
  "WS-14":
    "checklist.completed checklist.reminded equipment_service.reminded prep_list.created",
  "WS-00": "document.generated",
} as const;
export const eventCatalog: readonly EventCatalogEntry[] = Object.entries(
  namesByWorkstream,
).flatMap(([workstream, names]) =>
  names.split(" ").map((name) =>
    eventCatalogEntrySchema.parse({
      name,
      aggregateType: name.split(".")[0],
      version: 1,
      payloadSchemaRef: `${name}.v1`,
      workstream,
    }),
  ),
);
