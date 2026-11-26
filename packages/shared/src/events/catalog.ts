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
    "login_challenge.created login_challenge.completed identity.linked session.created session.revoked action_request.created action_request.approved action_request.executed role.updated employee_access.updated role.created role_assignment.granted role_assignment.ended approval_policy.changed approval.requested approval.decided approval.resolved tenant.created tenant.status_changed tenant.package_changed brand.created brand.updated outlet.created outlet.updated outlet.status_changed legal_entity.created legal_entity.updated tenant_domain.added tenant_domain.verified tenant_domain.removed tenant_integration.updated tenant_integration.status_changed tenant_theme.activated support_access.requested support_access.granted support_access.ended tenant_owner.changed config_import.completed usage_limit.reached staff_pin.set staff_pin.locked pos_override.recorded",
  "WS-02":
    "device.registered device.revoked print_job.created sync.batch_applied edge_link.dead_lettered edge_outbox.blocked catalog_record.updated pos_failover_window.state pos_failover_window.closed",
  "WS-03":
    "menu_item.updated price_list.updated table_session.opened table_session.joined cart.updated menu.updated item.sold_out item.restored table_session.closed table_session.moved table_session.merged table_session.items_moved order.placed item.failed order_issue.resolved order_issue.manual_refund_approved order_issue.refund_reversal_requested order_issue.charge_paid order_issue.charge_refunded service_request.created service_request.overdue open_bill.inactive open_bill.limit_exceeded table.status_changed table_session.linked table_session.unlinked",
  "WS-04":
    "order.submitted order.paid order.voided order.refunded kitchen_ticket.created kitchen_ticket.started kitchen_ticket.bumped kitchen_ticket.recalled kitchen_ticket.voided pacing.updated cashier_shift.opened cashier_shift.closed day.closed cash_movement.recorded cash_movement.approved receipt_run.reported",
  "WS-05":
    "payment_intent.created payment.paid payment.funds_unallocated payment.failed payment.refunded payment.provider_refunded payment.refund_requested payment.refund_escalated payment_route.updated edc_terminal.created edc_terminal.updated cashier_payment_default.updated settlement.reconciled notification.created notification.sent payment.expired settlement.imported tax_rule.published service_charge_rule.published tax_settings.published notification.failed notification.read notification_preference.updated subscription.invoice_created",
  "WS-06":
    "stock.deducted stock.adjusted stock.transferred recipe.updated production.completed purchase_order.created purchase_order.approved goods_receipt.recorded supplier_invoice.recorded supplier_invoice.matched supplier_payment.paid purchase_return.recorded petty_purchase.recorded stock.moved stock.critical recipe.cost_changed order_issue.recorded",
  "WS-07":
    "journal.posted fiscal_period.closed fiscal_period.reopened distribution.approved distribution.paid distribution.completed bank_statement.imported cash_deposit.recorded cash_deposit.matched reconciliation_case.opened reconciliation_case.resolved depreciation_run.posted tax_report.exported",
  "WS-08":
    "customer.created reservation.created reservation.confirmed reservation.seated reservation.completed reservation.cancelled reservation.rescheduled reservation.no_show reservation_preorder.placed waitlist_entry.called waitlist_entry.seated waitlist_entry.left delivery_order.received delivery_order.status_changed delivery_order.updated delivery_order.settled points.earned points.reversed points.redeemed points.expired tier.changed promotion.updated promo_application.redeemed promo_application.released voucher.issued promotion_outlet.changed promo_application.adjusted points.adjusted",
  "WS-09":
    "facility_entitlement.issued facility_entitlement.expired facility_entitlement.revoked access_ticket.issued access_ticket.redeemed access_event.recorded facility_session.started facility_session.ended cleaning_task.created subscription.billed wifi_quota.updated facility_incident.raised panic_alert.raised panic_alert.pressed panic_alert.delivered panic_alert.acknowledged panic_alert.resolved",
  "WS-10":
    "employee.updated attendance.logged shift.published shift.cancelled leave.approved leave.changed leave.rededucted_after_settlement payslip.created payroll.locked payroll.approval_requested payroll.paid payroll.reversed employee_loan.disbursed reimbursement.paid payout.step_attested payout.batch_disputed payout.batch_unfrozen",
  "WS-11": "metrics.aggregated report.generated",
  "WS-12":
    "ai_job.completed action_request.rejected action_request.failed action_request.expired ai_conversation.deleted mcp_client.registered mcp_client.approved mcp_client.revoked mcp_token.issued mcp_token.revoked ai_settings.updated ai_budget.threshold_reached ai_tool.invoked ai_insight.anomaly_detected ai_insight.daily_summary_ready",
  "WS-14":
    "checklist.completed checklist.reminded equipment_service.reminded prep_list.created checklist.missed checklist.failed temperature.out_of_range equipment.broken prep_label.expired",
  // Adapter layer (packages/shared/src/adapters). Emitted by the services that
  // wrap a provider, never by a provider itself. A webhook that fails signature
  // verification has no trusted tenant yet, so it is logged (gateway_webhook_events,
  // PRD §6), not published as a tenant event.
  // Text contract (packages/shared/src/text): one event per term override change.
  "WS-00":
    "document.generated provider_webhook.received wa_inbound_message.received outbound_message.sent outbound_message.failed edc_transaction.created edc_transaction.settled edc_transaction.cancelled edc_transaction.approved edc_transaction.declined edc_transaction.failed edc_transaction.flagged wifi_session.authorized wifi_session.revoked lock_credential.issued lock_credential.revoked delivery_channel.action_executed text_override.updated",
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
