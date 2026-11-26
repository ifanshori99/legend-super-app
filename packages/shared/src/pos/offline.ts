// O1 offline kit (bead legend-wasr7.5; docs/design/cloud-only-release.md §2,
// Moka/Majoo pattern). The cloud hands the device of an open shift a kit that
// lets the tablet keep selling while the internet is down: cash and manual EDC
// only, priced from the kit's versioned snapshot, numbered on the device's own
// offline receipt run (`L<n>`, one epoch).
//
// Epoch rule: a kit request that names the device's current offline run
// continues that run (the tablet still holds its local counter). Any other
// request means the local storage is gone: the cloud retires the old run and
// opens a new one under a never-used prefix, so no number is ever printed
// twice. The cloud's `lastNumber` is the high-water of numbers already synced
// (O2); the tablet continues from max(local counter, lastNumber).

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  serviceChargeRuleSchema,
  taxRuleSchema,
  taxSettingsSchema,
} from "../tax/schemas.ts";
import { receiptRunPrefixSchema } from "./receipts.ts";
import { posCatalogSchema, posShiftIdSchema } from "./schemas.ts";

/** A kit is valid for 24 hours from issue (CTO decision 27 Nov). */
export const OFFLINE_KIT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The only tenders a tablet may take offline: cash and a standalone EDC card
 * payment with the slip reference. QRIS/VA/e-wallet, points, vouchers, DP and
 * WFC passes need the cloud (founder decision no. 23).
 */
export const OFFLINE_TENDER_METHODS = ["cash", "edc_card"] as const;
export const offlineTenderMethodSchema = z.enum(OFFLINE_TENDER_METHODS);
export type OfflineTenderMethod = z.infer<typeof offlineTenderMethodSchema>;

/** The price lists a POS tablet sells from (posPriceChannel of `pos`). */
export const OFFLINE_KIT_SERVICE_TYPES = ["dine_in", "takeaway"] as const;

export const issuePosOfflineKitInputSchema = clientInputSchema({
  /**
   * The offline run the tablet still holds (its stored kit's
   * `receiptRun.sequenceId`), or null when it has none (first kit, or the
   * local storage was lost).
   */
  resumeSequenceId: uuidSchema.nullable(),
});
export type IssuePosOfflineKitInput = z.infer<
  typeof issuePosOfflineKitInputSchema
>;

export const posOfflineReceiptRunSchema = z.strictObject({
  sequenceId: uuidSchema,
  prefix: receiptRunPrefixSchema,
  /** Highest number the cloud already holds for this run (0 = none). */
  lastNumber: z.number().int().nonnegative().max(999_999_999),
  /** When this epoch started (the run's creation). */
  startedAt: isoDateTimeSchema,
});
export type PosOfflineReceiptRun = z.infer<typeof posOfflineReceiptRunSchema>;

export const posOfflineTaxSnapshotSchema = z.strictObject({
  taxRules: z.array(taxRuleSchema),
  settings: z.array(taxSettingsSchema),
  serviceChargeRules: z.array(serviceChargeRuleSchema),
});
export type PosOfflineTaxSnapshot = z.infer<typeof posOfflineTaxSnapshotSchema>;

export const posOfflineKitSchema = z.strictObject({
  kitId: uuidSchema,
  outletId: outletIdSchema,
  deviceId: uuidSchema,
  shiftId: uuidSchema,
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** SHA-256 (hex) of the priced snapshot: catalogs + tax. */
  catalogVersion: z.string().regex(/^[0-9a-f]{64}$/),
  catalogs: z.strictObject({
    dine_in: posCatalogSchema,
    takeaway: posCatalogSchema,
  }),
  tax: posOfflineTaxSnapshotSchema,
  tenders: z.array(offlineTenderMethodSchema),
  receiptRun: posOfflineReceiptRunSchema,
});
export type PosOfflineKit = z.infer<typeof posOfflineKitSchema>;

export const issuePosOfflineKit = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/offline-kit",
  params: z.strictObject({
    outletId: outletIdSchema,
    shiftId: posShiftIdSchema,
  }),
  body: issuePosOfflineKitInputSchema,
  response: dataResponseSchema(posOfflineKitSchema),
});
