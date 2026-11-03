// Page guard: the kelola area already needs dashboard.management.view + MFA;
// the inbox additionally needs approval.inbox.view (docs/frontend.md "Page
// guard"). The API re-checks every request.
import { accessGuard } from "@/features/ws01-access/guard";

export const approvalGuard = accessGuard(["approval.inbox.view"]);
