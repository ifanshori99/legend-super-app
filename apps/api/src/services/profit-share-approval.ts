// Approval-matrix identifiers for profit share (Codex 377/379, bead
// legend-33im6). Profit share opens its chains through the shared approval
// service (`openApprovalRequest`), like journals and purchasing: the matrix
// decides who approves and how many levels, never the module's own permission
// check alone. The `approval.resolved` consumer filters on these values.

/** `approval_requests.source_module` of every profit-share chain. */
export const PROFIT_SHARE_APPROVAL_SOURCE_MODULE = "profit_share";

/** A distribution run (regular or adjustment), matrix action `dividend_distribution`. */
export const DISTRIBUTION_RUN_OBJECT_TYPE = "distribution_run";

/** A change of a shareholder's statement recipient, matrix action `shareholder_version`. */
export const SHAREHOLDER_RECIPIENT_OBJECT_TYPE =
  "shareholder_recipient_version";

/** A share allocation version (SH-03), matrix action `shareholder_version`. */
export const SHARE_ALLOCATION_VERSION_OBJECT_TYPE = "share_allocation_version";
