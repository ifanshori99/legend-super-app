import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import { DEVICE_UNVERIFIED_CODE } from "../../shift-extra-types";
import { PosPageHeading, PosPanel, StateBlock, StatusPill } from "../shared";

/** The terminal could not be verified: the shift was neither opened nor closed. */
export function isDeviceUnverified(error: unknown): boolean {
  return error instanceof ApiError && error.code === DEVICE_UNVERIFIED_CODE;
}

export function ShiftDeviceError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  const outlet = useTenantContext().outlet;
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.device.title")}
        subtitle={outlet?.name ?? t("posKasirShift.device.pill")}
        action={
          <StatusPill tone="danger">
            {t("posKasirShift.device.pill")}
          </StatusPill>
        }
      />
      <PosPanel
        title={t("posKasirShift.device.panelTitle")}
        footer={
          <Button type="button" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        }
      >
        <StateBlock
          mark="fail"
          role="alert"
          title={t("posKasirShift.device.heading")}
          description={t("posKasirShift.device.body")}
        />
      </PosPanel>
    </div>
  );
}
