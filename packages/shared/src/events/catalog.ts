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
    "login_challenge.created login_challenge.completed identity.linked session.created action_request.created action_request.approved action_request.executed role.updated employee_access.updated role.created role_assignment.granted role_assignment.ended approval_policy.changed tenant.created tenant.status_changed tenant.package_changed brand.created brand.updated outlet.created outlet.updated outlet.status_changed legal_entity.created legal_entity.updated tenant_domain.added tenant_domain.verified tenant_domain.removed tenant_integration.updated tenant_integration.status_changed tenant_theme.activated support_access.granted support_access.ended config_import.completed usage_limit.reached",
  "WS-02":
    "device.registered device.revoked print_job.created sync.batch_applied",
  "WS-03":
    "menu_item.updated price_list.updated table_session.opened table_session.joined cart.updated menu.updated item.sold_out item.restored table_session.closed order.placed item.failed service_request.created",
  "WS-04":
    "order.submitted order.paid order.voided order.refunded kitchen_ticket.created kitchen_ticket.started kitchen_ticket.bumped kitchen_ticket.recalled kitchen_ticket.voided pacing.updated cashier_shift.opened cashier_shift.closed",
  "WS-05":
    "payment_intent.created payment.paid payment.failed payment.refunded settlement.reconciled notification.created notification.sent payment.expired settlement.imported tax_rule.published service_charge_rule.published tax_settings.published notification.failed notification.read notification_preference.updated",
  "WS-06":
    "stock.deducted stock.adjusted stock.transferred recipe.updated production.completed purchase_order.created goods_receipt.recorded supplier_invoice.recorded stock.moved stock.critical recipe.cost_changed",
  "WS-07":
    "journal.posted fiscal_period.closed fiscal_period.reopened distribution.completed bank_statement.imported cash_deposit.recorded cash_deposit.matched reconciliation_case.opened reconciliation_case.resolved depreciation_run.posted tax_report.exported",
  "WS-08":
    "customer.created reservation.created reservation.confirmed reservation.seated reservation.completed reservation.cancelled reservation.no_show reservation_preorder.placed waitlist_entry.called waitlist_entry.seated waitlist_entry.left delivery_order.received delivery_order.status_changed delivery_order.settled points.earned points.reversed points.redeemed points.expired tier.changed",
  "WS-09":
    "facility_entitlement.issued facility_entitlement.expired facility_entitlement.revoked access_ticket.issued access_ticket.redeemed access_event.recorded facility_session.started facility_session.ended cleaning_task.created subscription.billed wifi_quota.updated facility_incident.raised",
  "WS-10":
    "employee.updated attendance.logged shift.published leave.approved payroll_run.completed payslip.created",
  "WS-11": "metrics.aggregated report.generated",
  "WS-12": "ai_job.completed tool_request.approved",
  "WS-14":
    "checklist.completed checklist.reminded equipment_service.reminded prep_list.created",
  // Adapter layer (packages/shared/src/adapters). Emitted by the services that
  // wrap a provider, never by a provider itself. A webhook that fails signature
  // verification has no trusted tenant yet, so it is logged (gateway_webhook_events,
  // PRD §6), not published as a tenant event.
  // Text contract (packages/shared/src/text): one event per term override change.
  "WS-00":
    "document.generated provider_webhook.received wa_inbound_message.received outbound_message.sent outbound_message.failed edc_transaction.created edc_transaction.settled edc_transaction.cancelled wifi_session.authorized wifi_session.revoked lock_credential.issued lock_credential.revoked delivery_channel.action_executed text_override.updated",
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
