// EDC bridge tablet management (B2 legend-wasr7.21): list, create, revoke,
// assign terminals. Permission `payment.edc.manage` at the device's outlet.
// Creating a device (or issuing a new code) answers a one-time 8-character
// pairing code, never the device token; the tablet trades the code for its
// token at `EDC_BRIDGE_PAIR_PATH` (B4 legend-wasr7.24). UI: B4.
import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";
import { edcBridgePairingCodeSchema } from "./bridge.ts";

export const EDC_BRIDGE_DEVICES_PATH = "/api/edc-bridge/devices";
/** Tablet only, no session: code in, device token out. */
export const EDC_BRIDGE_PAIR_PATH = "/api/edc-bridge/pair";

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

/** A pairing code: shown once, valid until `expiresAt`, single use. Issuing a
 * new code for the device cancels the previous one. */
export const edcBridgePairCodeSchema = z.strictObject({
  code: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type EdcBridgePairCode = z.infer<typeof edcBridgePairCodeSchema>;

/** Create answer: the device and its first pairing code (no token). */
export const issuedEdcBridgeDeviceSchema = z.strictObject({
  device: edcBridgeDeviceSchema,
  pairCode: edcBridgePairCodeSchema,
});
export type IssuedEdcBridgeDevice = z.infer<typeof issuedEdcBridgeDeviceSchema>;

/** Tablet request at `EDC_BRIDGE_PAIR_PATH`. `deviceFingerprint` is accepted
 * for later use and not stored. */
export const pairEdcBridgeInputSchema = z.strictObject({
  code: edcBridgePairingCodeSchema,
  deviceFingerprint: z.string().trim().min(1).max(200).optional(),
});
export type PairEdcBridgeInput = z.infer<typeof pairEdcBridgeInputSchema>;

/** Pair answer: the only time the device token is shown. */
export const pairedEdcBridgeDeviceSchema = z.strictObject({
  deviceId: ulidSchema,
  token: z.string(),
});
export type PairedEdcBridgeDevice = z.infer<typeof pairedEdcBridgeDeviceSchema>;
