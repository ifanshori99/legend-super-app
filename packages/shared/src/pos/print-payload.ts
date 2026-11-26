// P1 (docs/design/cloud-only-release.md section 3): the cloud renders ESC/POS
// bytes and the cashier tablet sends them to its own printer (RawBT intent,
// "rawbt:base64,<escposBase64>"). The answer is the bytes only: the cloud never
// learns whether paper came out, so the status is "sent to printer", never
// "printed".
import { z } from "../core/index.ts";

/** Characters per line: 32 for 58 mm paper, 48 for 80 mm paper. */
export const printPaperWidthSchema = z.union([z.literal(32), z.literal(48)]);
export type PrintPaperWidth = z.infer<typeof printPaperWidthSchema>;

/** Query-string form of the paper width ("32" or "48"). */
export const printPaperWidthQuerySchema = z.coerce
  .number()
  .pipe(printPaperWidthSchema);

export const printPayloadSchema = z.strictObject({
  paperWidth: printPaperWidthSchema,
  /** Standard base64 of the ESC/POS bytes, ready for `rawbt:base64,`. */
  escposBase64: z.string().min(1).max(200_000),
  /** The bytes carry the "CETAK ULANG" banner. */
  reprint: z.boolean(),
});
export type PrintPayload = z.infer<typeof printPayloadSchema>;
