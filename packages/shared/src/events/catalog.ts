import { z } from "../core/index.ts";
import {
  aggregateTypeSchema,
  eventNameSchema,
  payloadSchemaRefOf,
} from "./schemas.ts";

/** Proposed v1 names, to be owned and refined by each workstream. Payload
 * references are stable identifiers, not a claim the domain schemas exist yet. */
export const eventCatalogEntrySchema = z
  .object({
    name: eventNameSchema,
    aggregateType: aggregateTypeSchema,
    version: z.number().int().positive().safe(),
    payloadSchemaRef: z.string().min(1).max(255),
    workstream: z.string().regex(/^WS-\d{2}$/),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.name.split(".")[0] !== entry.aggregateType)
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "Event name must match aggregate type",
      });
    if (
      entry.payloadSchemaRef !== payloadSchemaRefOf(entry.name, entry.version)
    )
      ctx.addIssue({
        code: "custom",
        path: ["payloadSchemaRef"],
        message: "payloadSchemaRef must be <name>.v<version>",
      });
  });
export type EventCatalogEntry = z.infer<typeof eventCatalogEntrySchema>;
const namesByWorkstream = {
  "WS-01":
    "login_challenge.created login_challenge.completed identity.linked session.created action_request.created action_request.approved action_request.executed role.updated employee_access.updated role.created role_assignment.granted role_assignment.ended approval_policy.changed",
  "WS-02":
    "device.registered device.revoked print_job.created sync.batch_applied",
  "WS-03":
    "menu_item.updated price_list.updated table_session.opened table_session.joined cart.updated menu.updated item.sold_out item.restored",
  "WS-04":
    "order.submitted order.paid order.voided order.refunded kitchen_ticket.created kitchen_ticket.updated cashier_shift.opened cashier_shift.closed",
  "WS-05":
    "payment_intent.created payment.paid payment.failed payment.refunded settlement.reconciled notification.created notification.sent payment.expired settlement.imported",
  "WS-06":
    "stock.deducted stock.adjusted stock.transferred recipe.updated production.completed purchase_order.created goods_receipt.recorded supplier_invoice.recorded",
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
  // Adapter layer (packages/shared/src/adapters). Emitted by the services that
  // wrap a provider, never by a provider itself. A webhook that fails signature
  // verification has no trusted tenant yet, so it is logged (gateway_webhook_events,
  // PRD §6), not published as a tenant event.
  "WS-00":
    "document.generated provider_webhook.received wa_inbound_message.received outbound_message.sent outbound_message.failed edc_transaction.created edc_transaction.settled edc_transaction.cancelled wifi_session.authorized wifi_session.revoked lock_credential.issued lock_credential.revoked delivery_channel.action_executed",
} as const;
export const eventCatalog: readonly EventCatalogEntry[] = Object.freeze(
  Object.entries(namesByWorkstream).flatMap(([workstream, names]) =>
    names.split(" ").map((name) =>
      Object.freeze(
        eventCatalogEntrySchema.parse({
          name,
          aggregateType: name.split(".")[0],
          version: 1,
          payloadSchemaRef: payloadSchemaRefOf(name, 1),
          workstream,
        }),
      ),
    ),
  ),
);
const catalogByName: ReadonlyMap<string, EventCatalogEntry> = new Map(
  eventCatalog.map((entry) => [entry.name, entry]),
);
/** Lookup by event name (`order.paid`). */
export const eventCatalogByName = catalogByName;
