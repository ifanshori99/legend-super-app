/**
 * Reserved system account (legend-2dnh, migration 0135): the approval-chain
 * requester of refunds the system creates (late payment, reservation deposit).
 * Banned, no sign-in account, no role and no role assignment; database triggers
 * keep it that way on every path.
 */
export const SYSTEM_ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
