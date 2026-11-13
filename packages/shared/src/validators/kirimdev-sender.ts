// Kirimdev sender mapping (legend-nqxtb): which WhatsApp sender number a
// tenant (or one of its outlets) sends from. Written by the platform only.
import { z } from "zod";

/** The number goes into a URL path: a plain token only. */
export const kirimdevPhoneNumberIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, _ or - (max 64).");

export const kirimdevSenderMappingIdSchema = z.uuid();

export const upsertKirimdevSenderMappingInputSchema = z.strictObject({
  tenantId: z.uuid(),
  outletId: z.uuid().nullable(),
  phoneNumberId: kirimdevPhoneNumberIdSchema,
});

export const listKirimdevSenderMappingsQuerySchema = z.strictObject({
  tenantId: z.uuid(),
});

export const kirimdevSenderMappingParamsSchema = z.strictObject({
  id: kirimdevSenderMappingIdSchema,
});

/** The id alone does not name a tenant (RLS), so delete names it too. */
export const deleteKirimdevSenderMappingQuerySchema = z.strictObject({
  tenantId: z.uuid(),
});

export type UpsertKirimdevSenderMappingInput = z.infer<
  typeof upsertKirimdevSenderMappingInputSchema
>;
export type ListKirimdevSenderMappingsQuery = z.infer<
  typeof listKirimdevSenderMappingsQuerySchema
>;
export type DeleteKirimdevSenderMappingQuery = z.infer<
  typeof deleteKirimdevSenderMappingQuerySchema
>;
