// @starter/shared/hris/payroll/server — SERVER-ONLY payroll payloads.
//
// `bankTransferRowSchema` holds the DECRYPTED bank account number of one
// employee: it is built inside the API when the transfer file is generated,
// written to the private bucket, and never sent to a browser, logged, audited
// or put in an event (HR-03, PAYR-04). It is deliberately excluded from the
// client-safe `@starter/shared/hris/payroll` barrel; import this subpath from
// apps/api only. Like `@starter/shared/core/server`, it refuses to load where
// a DOM exists, so a client bundle that imports it fails at once instead of
// shipping the account numbers' schema into the browser.

import { z, idrSchema } from "../../core/index.ts";
import { employeeIdSchema } from "../ids.ts";

if (typeof (globalThis as { document?: unknown }).document !== "undefined")
  throw new Error(
    "@starter/shared/hris/payroll/server is server-only and must not be bundled for the browser",
  );

const positiveIdr = idrSchema.refine((v) => v > 0, "Must be positive");

/** One bank-transfer line of a run's payroll file (raw account number). */
export const bankTransferRowSchema = z.strictObject({
  employeeId: employeeIdSchema,
  employeeNo: z.string().min(2).max(30),
  accountHolderName: z.string().trim().min(1).max(150),
  bankCode: z.string().regex(/^[0-9A-Z]{3,11}$/, "Bank code or SWIFT"),
  accountNumber: z.string().regex(/^\d{5,34}$/, "Digits only"),
  amountIdr: positiveIdr,
  /** Transfer remark, e.g. "GAJI 2026-11 EMP-1004". */
  reference: z.string().regex(/^[A-Z0-9 .:/-]{1,40}$/),
});
export type BankTransferRow = z.infer<typeof bankTransferRowSchema>;
