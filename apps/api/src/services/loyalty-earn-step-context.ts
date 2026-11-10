// Shared type of the earn steps (legend-111j, docs/design/ws08-member-loyalty.md
// §M6 step 8). Type only: the consumer and the three step files import it, so
// no step file imports the consumer (no cycle).

import type {
  customerProfiles,
  loyaltyPrograms,
  pointEarnRecords,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";

export type EarnProfileRow = typeof customerProfiles.$inferSelect;
export type EarnProgramRow = typeof loyaltyPrograms.$inferSelect;
export type EarnRecordRow = typeof pointEarnRecords.$inferSelect;

/**
 * Steps run in the consumption transaction under the profile lock and write
 * ledger rows only through `point-ledger.service.ts`. A replay stops at the
 * earn record, so a step never runs twice for one order.
 */
export type EarnStepContext = {
  tx: Tx;
  tenantId: string;
  /** The locked member profile. */
  profile: EarnProfileRow;
  program: EarnProgramRow;
  order: {
    id: string;
    outletId: string;
    channel: string;
    businessDate: string;
    paidAt: Date;
    eligibleSpendIdr: number;
  };
  /** The earn record of this order (provisional before the tier step). */
  record: EarnRecordRow;
};
