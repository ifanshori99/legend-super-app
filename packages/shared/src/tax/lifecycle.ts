// Rule-version lifecycle (tax rules, service-charge rules, settings):
//   draft -> published   (immutable from then on; effectiveFrom >= today, R21)
//   draft -> archived    (discarded draft)
// A published version never changes status: to change or stop a rule, publish
// a new version (isActive: false stops the code). History stays reproducible,
// and past transactions are fixed by adjustment journals (PRD R21).

import type { BusinessDate, IsoDateTime, UserId } from "../core/index.ts";
import { TaxError } from "./errors.ts";
import type { RuleVersionStatus } from "./schemas.ts";

const transitions: Record<RuleVersionStatus, readonly RuleVersionStatus[]> = {
  draft: ["published", "archived"],
  published: [],
  archived: [],
};

export function canTransitionRuleVersion(
  from: RuleVersionStatus,
  to: RuleVersionStatus,
): boolean {
  return transitions[from].includes(to);
}

/** Only drafts can be edited. */
export function assertRuleVersionEditable(status: RuleVersionStatus): void {
  if (status !== "draft") throw new TaxError("TAX_RULE_IMMUTABLE");
}

type Versioned = {
  status: RuleVersionStatus;
  effectiveFrom: BusinessDate;
  publishedAt: IsoDateTime | null;
  publishedBy: UserId | null;
};

/**
 * Publishes a draft version. `today` is the outlet business date computed by
 * the server (businessDateOf), never the client's clock.
 */
export function publishRuleVersion<T extends Versioned>(
  version: T,
  options: { today: BusinessDate; actorId: UserId; at: IsoDateTime },
): T {
  if (!canTransitionRuleVersion(version.status, "published"))
    throw new TaxError(
      version.status === "published"
        ? "TAX_RULE_IMMUTABLE"
        : "TAX_INVALID_TRANSITION",
    );
  // ISO dates compare correctly as strings.
  if (version.effectiveFrom < options.today)
    throw new TaxError("TAX_RULE_BACKDATED");
  return {
    ...version,
    status: "published",
    publishedAt: options.at,
    publishedBy: options.actorId,
  };
}

export function archiveRuleVersion<T extends Versioned>(version: T): T {
  if (!canTransitionRuleVersion(version.status, "archived"))
    throw new TaxError(
      version.status === "published"
        ? "TAX_RULE_IMMUTABLE"
        : "TAX_INVALID_TRANSITION",
    );
  return { ...version, status: "archived" };
}
