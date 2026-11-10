// Menu bulk import + printable menu wire contract (beads legend-l8zb,
// legend-az32; PRD v1.7 §3 F8). Moved here from menu-import.routes.ts with the
// wire shapes unchanged. The server parses CSV and XLSX (`fileName` decides),
// so the browser only sends bytes as base64.
//
//   POST /api/menu/import/validate   per-row report, writes nothing
//   POST /api/menu/import/preview    report + normalised rows
//   POST /api/menu/import/commit     atomic; header Idempotency-Key required
//   GET  /api/menu/print             latest printable PDF (signed URL)
//   POST /api/menu/print/refresh     regenerate now

import {
  z,
  brandIdSchema,
  outletIdSchema,
  clientInputSchema,
} from "../core/index.ts";
import { channelSchema, importRowSchema } from "./schemas.ts";

/** Raw file limit enforced by the server parser (`IMPORT_MAX_FILE_BYTES`). */
export const MENU_IMPORT_MAX_FILE_BYTES = 1024 * 1024;

/** Longest base64 text that can encode `MENU_IMPORT_MAX_FILE_BYTES`. */
export const MENU_IMPORT_MAX_BASE64_LENGTH =
  Math.ceil((MENU_IMPORT_MAX_FILE_BYTES * 4) / 3) + 4;

export const menuImportInputSchema = clientInputSchema({
  fileName: z.string().min(1).max(120),
  dataBase64: z
    .string()
    .min(1)
    .max(MENU_IMPORT_MAX_BASE64_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Data berkas harus base64"),
  brandId: brandIdSchema.optional(),
  outletId: outletIdSchema.optional(),
  channel: channelSchema.optional(),
  onDuplicate: z.enum(["reject", "update"]).optional(),
});

export const menuPrintQuerySchema = z.strictObject({
  outletId: outletIdSchema.optional(),
});

export const menuImportRowErrorSchema = z.strictObject({
  /** Canonical column, or `row` for a whole-row problem. */
  field: z.string(),
  code: z.enum([
    "REQUIRED",
    "INVALID",
    "FORMULA_NOT_ALLOWED",
    "DUPLICATE_IN_FILE",
    "DUPLICATE_EXISTING",
    "TOO_LONG",
  ]),
  message: z.string(),
});

/** `POST /import/validate|preview` result (`data` is only set on preview). */
export const menuImportReportSchema = z.strictObject({
  fileHash: z.string(),
  format: z.enum(["csv", "xlsx"]),
  outletId: outletIdSchema,
  totalRows: z.number().int().nonnegative(),
  validRows: z.number().int().nonnegative(),
  errorRows: z.number().int().nonnegative(),
  summary: z.strictObject({
    itemsToCreate: z.number().int().nonnegative(),
    itemsToUpdate: z.number().int().nonnegative(),
    categoriesToCreate: z.number().int().nonnegative(),
  }),
  rows: z.array(
    z.strictObject({
      /** Spreadsheet row number; the header is row 1. */
      rowNumber: z.number().int().positive(),
      action: z.enum(["create", "update", "error"]),
      errors: z.array(menuImportRowErrorSchema),
      data: importRowSchema.optional(),
    }),
  ),
});

export type MenuImportInputBody = z.infer<typeof menuImportInputSchema>;
export type MenuPrintQuery = z.infer<typeof menuPrintQuerySchema>;
export type MenuImportRowError = z.infer<typeof menuImportRowErrorSchema>;
export type MenuImportReport = z.infer<typeof menuImportReportSchema>;
