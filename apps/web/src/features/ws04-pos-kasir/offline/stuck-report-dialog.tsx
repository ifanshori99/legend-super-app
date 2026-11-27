// 1273 second opinion P2-1: "Laporkan ke kantor" for a sale the cloud refuses
// for good. A supervisor picks themselves, writes a reason and types their
// PIN; the queue sends the sale (reportPosOfflineStuck) and drops it from the
// tablet only once the cloud answers it held or ingested. Any failure keeps it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatRupiah } from "@starter/shared/i18n";
import type { OfflineStuckReason } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/errors";
import {
  Notice,
  SupervisorPinDialog,
} from "@/features/ws04-pos-kasir/components/shared";
import { useTenantContext } from "@/lib/tenant-context";
import type { OfflineQueue, OfflineStuckSale } from "./queue";

const REASON_MIN_LENGTH = 4;

export function StuckReportDialog({
  sale,
  receiptNumber,
  queue,
  onOpenChange,
  onReported,
}: {
  /** The sale being reported; null keeps the dialog closed. */
  sale: OfflineStuckSale | null;
  receiptNumber: string;
  queue: Pick<OfflineQueue, "reportStuck">;
  onOpenChange: (open: boolean) => void;
  /** The cloud holds the sale; it is gone from the tablet. */
  onReported: () => void;
}) {
  const t = useT();
  const outletId = useTenantContext().outlet?.id ?? "";
  const open = sale !== null;
  const approvers = useQuery({
    queryKey: ["pos-offline", "stuck-approvers", outletId],
    // Loaded on open: the sheet itself stays free of the API client (it also
    // renders in the server-side component tests).
    queryFn: () =>
      import("./api").then((api) => api.fetchStuckApprovers(outletId)),
    enabled: open && outletId !== "",
  });
  const [pickedId, setPickedId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = approvers.data ?? [];
  const approverUserId = (
    options.find((option) => option.userId === pickedId) ?? options[0]
  )?.userId;

  async function submit(reason: string, pin: string) {
    if (!sale || pending) return;
    if (!approverUserId)
      return setError(t("posCorrection.approval.supervisorPlaceholder"));
    setPending(true);
    setError(null);
    try {
      await queue.reportStuck(sale.event.eventId, {
        reason,
        approverUserId,
        pin,
      });
      setPending(false);
      onReported();
    } catch (caught) {
      setPending(false);
      // A refusal says why (wrong PIN, no permission); anything else is the
      // network: the sale stays on the tablet either way.
      setError(
        caught instanceof ApiError && caught.status < 500
          ? caught.message
          : t("posKasirOffline.stuck.networkError"),
      );
    }
  }

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        setError(null);
        onOpenChange(next);
      }}
      locked={pending}
      title={t("posKasirOffline.stuck.dialogTitle")}
      summary={t("posKasirOffline.stuck.dialogSummary", {
        receipt: receiptNumber,
        amount: formatRupiah(sale?.event.totalIdr ?? 0),
      })}
      details={
        <div className="grid gap-3">
          {(approvers.isError || approvers.data?.length === 0) && (
            <Notice
              tone="warning"
              title={t(
                approvers.isError
                  ? "posCorrection.approval.supervisorsError"
                  : "posCorrection.approval.supervisorsEmpty",
              )}
            />
          )}
          <FormField
            label={t("posCorrection.approval.supervisorLabel")}
            hint={t("posCorrection.approval.supervisorHint")}
            required
          >
            <Select
              value={approverUserId ?? ""}
              onValueChange={(next) => setPickedId(next || undefined)}
              disabled={pending}
            >
              <SelectTrigger className="h-control">
                <SelectValue
                  placeholder={t(
                    "posCorrection.approval.supervisorPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.userId} value={option.userId}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      }
      onSubmit={({ reason, pin }) => void submit(reason, pin)}
      pending={pending}
      error={error}
      minReasonLength={REASON_MIN_LENGTH}
    />
  );
}

/** Text key of why the cloud refuses the sale. */
export function stuckReasonKey(stuck: OfflineStuckReason) {
  return `posKasirOffline.stuck.reason.${stuck}` as const;
}
