import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { TenantStatus } from "@starter/shared/platform";
import { TENANT_STATUS_LABEL, TENANT_STATUS_TONE } from "../logic";

/** Status in words (never colour alone, WCAG 1.4.1). */
export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const t = useT();
  return (
    <Badge tone={TENANT_STATUS_TONE[status]}>
      {t(TENANT_STATUS_LABEL[status])}
    </Badge>
  );
}
