import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outlets } from "./platform-org";
import { staffPinProofs } from "./staff-pin-proof";

export const coreStorageObjects = pgTable(
  "core_storage_objects",
  {
    tenantId: uuid("tenant_id").notNull(),
    // Null only for tenant-level assets (purpose brand_logo); see the
    // core_storage_objects_outlet_purpose_check constraint.
    outletId: uuid("outlet_id"),
    id: uuid("id").notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    objectKey: text("object_key").notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    thumbnailKey: text("thumbnail_key"),
    // Owner and source (bead legend-pszrm). The owner is the uploader, or the
    // subject once a feature links the object (the employee on a document).
    // The source is the feature document that uses the object; reviewers read
    // only kinds their permission covers. Rows from before 0177 keep all three
    // null and are read only by the purpose's manager codes.
    ownerUserId: text("owner_user_id"),
    sourceKind: varchar("source_kind", { length: 32 }),
    sourceId: uuid("source_id"),
    // Who uploaded the file (bead legend-0pth). Set once at insert from the
    // verified actor and never rewritten, unlike owner_user_id which a link
    // can reassign. Null for rows from before 0323 and for system uploads.
    uploadedBy: text("uploaded_by"),
    // The PIN proof that authorised an outlet-device selfie upload (bead
    // legend-u7g9w). Set by the server only; ON DELETE SET NULL.
    pinProofId: uuid("pin_proof_id").references(() => staffPinProofs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "core_storage_objects_source_kind_check",
      sql`${table.sourceKind} IS NULL OR ${table.sourceKind} IN ('purchase_invoice', 'goods_receipt', 'expense', 'cash_deposit', 'reimbursement', 'attendance', 'employee_document', 'employment_contract', 'leave_request', 'menu_item', 'petty_purchase', 'waste_log', 'cleaning_task', 'maintenance_ticket', 'checklist_evidence')`,
    ),
    check(
      "core_storage_objects_source_check",
      sql`${table.sourceId} IS NULL OR ${table.sourceKind} IS NOT NULL`,
    ),
    check(
      "core_storage_objects_outlet_purpose_check",
      sql`(${table.outletId} IS NULL) = (${table.purpose} = 'brand_logo')`,
    ),
    index("core_storage_objects_source_idx").on(
      table.tenantId,
      table.sourceKind,
      table.sourceId,
    ),
    primaryKey({ columns: [table.tenantId, table.id] }),
    // Tenant-scoped reference: an object can only belong to its own tenant's outlet.
    foreignKey({
      name: "core_storage_objects_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
  ],
);
