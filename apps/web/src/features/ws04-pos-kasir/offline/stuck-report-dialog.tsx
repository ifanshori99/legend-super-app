// 1273 second opinion P2-1: "Laporkan ke kantor" for a sale the cloud refuses
// for good. A supervisor picks themselves, writes a reason and types their
// PIN; the queue sends the sale (reportPosOfflineStuck) and drops it from the
// tablet only once the cloud answers it held or ingested. Any failure keeps it
// and keeps the dialog open with what went wrong.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatRupiah } from "@starter/shared/i18n";
import type { OfflineStuckReason } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import {
  Notice,
  SupervisorPinDialog,
} from "@/features/ws04-pos-kasir/components/shared";
import { OfflineSaleError } from "./price";
import type { OfflineQueue, OfflineStuckSale } from "./queue";

const REASON_MIN_LENGTH = 4;

type T = ReturnType<typeof useT>;

/** What the cashier reads after a failed report; the sale stays either way. */
export function stuckReportErrorText(error: unknown, t: T): string {
  if (error instanceof OfflineSaleError)
    return t("posKasirOffline.stuck.error.notSettled");
  if (!(error instanceof ApiError))
    return t("posKasirOffline.stuck.error.network");
  if (error.status >= 500) return t("posKasirOffline.stuck.error.server");
  switch (error.code) {
    case "PIN_INVALID":
      return t("posKasirOffline.stuck.error.pinInvalid");
    case "PIN_LOCKED":
    case "STAFF_PIN_RESET_REQUIRED":
      return t("posKasirOffline.stuck.error.pinLocked");
    case "APPROVER_IS_REQUESTER":
      return t("posKasirOffline.stuck.error.sameUser");
    case "OFFLINE_SALE_NOT_STUCK":
      return t("posKasirOffline.stuck.error.notStuck");
  }
  if (error.status === 401) return t("posKasirOffline.stuck.error.session");
  if (error.status === 403) return t("posKasirOffline.stuck.error.forbidden");
  if (error.status === 429) return t("posKasirOffline.stuck.error.throttled");
  return t("posKasirOffline.stuck.error.refused");
}

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
    if (!sale || pending || !approverUserId) return;
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
      setError(stuckReportErrorText(caught, t));
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
        <StuckApproverField
          status={
            approvers.isPending
              ? "loading"
              : approvers.isError
                ? "error"
                : options.length === 0
                  ? "empty"
                  : "ready"
          }
          options={options}
          value={approverUserId}
          onChange={setPickedId}
          onRetry={() => void approvers.refetch()}
          retrying={approvers.isFetching}
          disabled={pending}
          t={t}
        />
      }
      onSubmit={({ reason, pin }) => void submit(reason, pin)}
      pending={pending}
      // No PIN before a supervisor is picked (loading, error or none).
      pinDisabled={!approverUserId}
      error={error}
      minReasonLength={REASON_MIN_LENGTH}
    />
  );
}

/** The supervisor picker with its loading, failure and empty states. */
export function StuckApproverField({
  status,
  options,
  value,
  onChange,
  onRetry,
  retrying,
  disabled,
  t,
}: {
  status: "loading" | "error" | "empty" | "ready";
  options: { userId: string; name: string }[];
  value: string | undefined;
  onChange: (userId: string | undefined) => void;
  onRetry: () => void;
  retrying: boolean;
  disabled: boolean;
  t: T;
}) {
  return (
    <div className="grid gap-3">
      {status === "error" && (
        <Notice
          tone="warning"
          title={t("posCorrection.approval.supervisorsError")}
        >
          <Button
            type="button"
            variant="outline"
            loading={retrying}
            onClick={onRetry}
            className="mt-2"
          >
            {t("posKasirOffline.stuck.retrySupervisors")}
          </Button>
        </Notice>
      )}
      {status === "empty" && (
        <Notice
          tone="warning"
          title={t("posCorrection.approval.supervisorsEmpty")}
        />
      )}
      <FormField
        label={t("posCorrection.approval.supervisorLabel")}
        hint={t("posKasirOffline.stuck.supervisorHint")}
        required
      >
        <Select
          value={value ?? ""}
          onValueChange={(next) => onChange(next || undefined)}
          disabled={disabled || status !== "ready"}
        >
          <SelectTrigger className="h-control" aria-busy={status === "loading"}>
            <SelectValue
              placeholder={t(
                status === "loading"
                  ? "posKasirOffline.stuck.loadingSupervisors"
                  : "posCorrection.approval.supervisorPlaceholder",
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
  );
}

/** Text key of why the cloud refuses the sale. */
export function stuckReasonKey(stuck: OfflineStuckReason) {
  return `posKasirOffline.stuck.reason.${stuck}` as const;
}
