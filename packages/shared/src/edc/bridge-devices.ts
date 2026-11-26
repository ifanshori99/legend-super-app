// EDC bridge tablet management (B2 legend-wasr7.21): list, issue a device
// token (shown once), revoke, assign terminals. Permission
// `payment.edc.manage` at the device's outlet. UI: B4.
import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";

export const EDC_BRIDGE_DEVICES_PATH = "/api/edc-bridge/devices";

export const listEdcBridgeDevicesQuerySchema = z.strictObject({
  outletId: outletIdSchema,
});

export const createEdcBridgeDeviceInputSchema = z.strictObject({
  outletId: outletIdSchema,
  label: z.string().trim().min(1).max(100),
});
export type CreateEdcBridgeDeviceInput = z.infer<
  typeof createEdcBridgeDeviceInputSchema
>;

export const edcBridgeDeviceParamsSchema = z.strictObject({
  deviceId: ulidSchema,
});

const baudRateSchema = z.union([
  z.literal(9_600),
  z.literal(19_200),
  z.literal(38_400),
  z.literal(57_600),
  z.literal(115_200),
]);

/** The full set of terminals the tablet drives; any other terminal of the
 * device is unassigned. LAN terminals need `linkPort`, USB `linkBaudRate`. */
export const assignEdcBridgeTerminalsInputSchema = z.strictObject({
  terminals: z
    .array(
      z.strictObject({
        terminalId: uuidSchema,
        linkPort: z.number().int().min(1).max(65_535).nullable(),
        linkBaudRate: baudRateSchema.nullable(),
      }),
    )
    .max(8),
});
export type AssignEdcBridgeTerminalsInput = z.infer<
  typeof assignEdcBridgeTerminalsInputSchema
>;

export const edcBridgeDeviceSchema = z.strictObject({
  id: ulidSchema,
  outletId: uuidSchema,
  label: z.string(),
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  terminalIds: z.array(uuidSchema),
});
export type EdcBridgeDeviceView = z.infer<typeof edcBridgeDeviceSchema>;

/** Create answer: the only time the token is shown. */
export const issuedEdcBridgeDeviceSchema = z.strictObject({
  device: edcBridgeDeviceSchema,
  token: z.string(),
});
export type IssuedEdcBridgeDevice = z.infer<typeof issuedEdcBridgeDeviceSchema>;
