// EDC bridge tablets, terminal leases and commands (B2 legend-wasr7.21;
// design docs/design/edc-auto-cloud.md, protocol docs/design/edc-bridge-protocol.md).
//
// - Devices: edc-bridge-devices.ts.
// - `edc_bridge_terminal_leases`: one row per terminal, the tablet that may
//   talk to it. Another tablet gets it only after `issued_at + ttl_ms + 300 s +
//   30 s` on the cloud clock (`edcBridgeLeaseReusableAt`), so two tablets never
//   drive one EDC.
// - `edc_bridge_commands`: every command the cloud sent, by device. A `result`
//   is accepted only for a command sent to that device with the same terminal,
//   op and trace; a late one is matched inside tenant + outlet + terminal. No
//   frame is stored (a raw terminal answer may carry a PAN); the decoded
//   answer without PAN is (`result_evidence`), so a late result keeps its
//   approval code and RRN.
// - Tenant + outlet RLS: edc-bridge.custom.sql (migration 0541).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edcBridgeDevices } from "./edc-bridge-devices.ts";
import { paymentEdcTerminals } from "./payment-admin.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edcBridgeTerminalLeases = pgTable(
  "edc_bridge_terminal_leases",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    terminalId: uuid("terminal_id").primaryKey(),
    deviceId: ulidInUuid("device_id").notNull(),
    leaseId: uuid("lease_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    ttlMs: integer("ttl_ms").notNull(),
  },
  (t) => [
    foreignKey({
      name: "edc_bridge_terminal_leases_device_fk",
      columns: [t.tenantId, t.outletId, t.deviceId],
      foreignColumns: [
        edcBridgeDevices.tenantId,
        edcBridgeDevices.outletId,
        edcBridgeDevices.id,
      ],
    }),
    foreignKey({
      name: "edc_bridge_terminal_leases_terminal_fk",
      columns: [t.tenantId, t.outletId, t.terminalId],
      foreignColumns: [
        paymentEdcTerminals.tenantId,
        paymentEdcTerminals.outletId,
        paymentEdcTerminals.id,
      ],
    }),
    foreignKey({
      name: "edc_bridge_terminal_leases_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edc_bridge_terminal_leases_ttl_check",
      sql`${t.ttlMs} BETWEEN 10000 AND 600000`,
    ),
  ],
);

export const edcBridgeCommands = pgTable(
  "edc_bridge_commands",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    terminalId: uuid("terminal_id").notNull(),
    deviceId: ulidInUuid("device_id").notNull(),
    leaseId: uuid("lease_id").notNull(),
    op: varchar("op", { length: 10 }).notNull(),
    trace: varchar("trace", { length: 32 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    // `response` | `transport_error` | `refused`; the frame is never kept.
    resultOutcome: varchar("result_outcome", { length: 20 }),
    resultAt: timestamp("result_at", { withTimezone: true }),
    /** What the terminal answered, decoded, without PAN or free text
     * (`EdcBridgeResultEvidence`); null when unreadable or not answered. */
    resultEvidence: jsonb("result_evidence").$type<Record<string, unknown>>(),
    // `sale_record_release` for this sale's trace reached the device.
    releaseSentAt: timestamp("release_sent_at", { withTimezone: true }),
  },
  (t) => [
    index("edc_bridge_commands_trace_idx").on(
      t.tenantId,
      t.terminalId,
      t.trace,
    ),
    index("edc_bridge_commands_device_release_idx").on(
      t.tenantId,
      t.deviceId,
      t.releaseSentAt,
    ),
    foreignKey({
      name: "edc_bridge_commands_device_fk",
      columns: [t.tenantId, t.outletId, t.deviceId],
      foreignColumns: [
        edcBridgeDevices.tenantId,
        edcBridgeDevices.outletId,
        edcBridgeDevices.id,
      ],
    }),
    foreignKey({
      name: "edc_bridge_commands_terminal_fk",
      columns: [t.tenantId, t.outletId, t.terminalId],
      foreignColumns: [
        paymentEdcTerminals.tenantId,
        paymentEdcTerminals.outletId,
        paymentEdcTerminals.id,
      ],
    }),
    foreignKey({
      name: "edc_bridge_commands_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edc_bridge_commands_op_check",
      sql`${t.op} IN ('sale','cancel','inquiry','void')`,
    ),
    check(
      "edc_bridge_commands_outcome_check",
      sql`${t.resultOutcome} IS NULL OR ${t.resultOutcome} IN ('response','transport_error','refused')`,
    ),
    check(
      "edc_bridge_commands_result_check",
      sql`(${t.resultOutcome} IS NULL) = (${t.resultAt} IS NULL)`,
    ),
  ],
);
