// Direct approve of a pending cash entry posts only after the approval chain
// is fully approved (legend-3bkvl). These tests exercise the direct endpoint,
// so the helper first lets `who` decide the open chain level in the inbox
// (what a real approver does), then the caller hits the direct endpoint. A
// refused decision (creator, no permission, already decided, rejected chain)
// is ignored: the direct endpoint then answers on its own rules.
import { establishTenantContext } from "@starter/shared/core/server";
import { decideApprovalRequest } from "../../services/platform-approval.service.ts";
import { owner, tenantId, type Session } from "./cash-bank-world.ts";

export async function approveChainLevelAs(
  who: Session,
  entryId: string,
): Promise<void> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'cash_bank_entry'
        AND object_id = $2 AND status = 'pending'
      ORDER BY created_at`,
    [tenantId, entryId],
  );
  for (const row of rows) {
    try {
      await decideApprovalRequest(
        establishTenantContext({ tenantId, brandId: null, source: "session" }),
        who.userId,
        row.id,
        { decision: "approved", reason: "Sesuai bukti pembayaran." },
        { mfaVerified: true, idempotencyKey: null },
      );
    } catch {
      // Not this user's decision to make; the direct endpoint answers.
    }
  }
}
