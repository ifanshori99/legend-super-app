// "Cuti / izin" tab (mockup cuti-mobile): balance, type, dates, reason. The
// Attachment uploads complete before submitting the leave request.
import { useState, type FormEvent } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useLeaveBalances,
  useLeaveTypes,
} from "@/features/hris-requests/hooks";
import { isLeavePdf, uploadLeaveFile } from "../leave-upload.ts";
import { useStorageCapabilities } from "@/features/hris-requests/storage-capabilities/hooks";
import { ApiError } from "@/lib/api/errors";
import { formatBusinessDate } from "@/features/ws10-payslip/format";
import {
  formatDays,
  leaveDayCount,
  REASON_MAX,
  remainingLeaveDays,
  rowsOf,
  validateLeave,
  type LeaveErrors,
  type LeavePayload,
} from "./request-form-logic.ts";
import { FormLoading, SubmitFailure } from "./request-form-loading.tsx";
import type { RequestSummary } from "./request-form-states.tsx";
import type { LeaveBalance, LeaveType } from "@starter/shared/hris";

export type LeaveSubmit = { payload: LeavePayload; summary: RequestSummary };

export function RequestFormLeave({
  busy,
  failed,
  year,
  onSubmit,
}: {
  busy: boolean;
  failed: boolean;
  /** Business year of the outlet, for the balance row. */
  year: number;
  onSubmit: (request: LeaveSubmit) => void;
}) {
  const t = useT();
  const typesQuery = useLeaveTypes();
  const balancesQuery = useLeaveBalances();
  const { documentsAccepted } = useStorageCapabilities();
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [errors, setErrors] = useState<LeaveErrors>({});

  const types = rowsOf<LeaveType>(typesQuery.data).filter(
    (type) => type.isActive,
  );
  const balances = rowsOf<LeaveBalance>(balancesQuery.data);
  const selected = types.find((type) => type.id === leaveTypeId);
  const remaining = selected
    ? remainingLeaveDays(balances, selected.id, year)
    : null;
  const days = leaveDayCount(startDate, endDate);
  const overBalance = remaining !== null && days !== null && days > remaining;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { errors: next, payload } = validateLeave(
      { leaveTypeId, startDate, endDate, reason },
      {
        requiresAttachment: selected?.requiresAttachment,
        hasAttachment: file !== null,
      },
    );
    if (selected?.requiresAttachment && !file) {
      setFileError("Pilih lampiran terlebih dahulu.");
      if (
        next.leaveTypeId ===
        "hrisRequestsEmployee.leave.errors.attachmentBlocked"
      )
        delete next.leaveTypeId;
    }
    setErrors(next);
    if (!payload) return;
    setFileError("");
    if (file) {
      setUploading(true);
      try {
        payload.attachmentUploadRef = await uploadLeaveFile(file);
      } catch (error) {
        setFileError(
          error instanceof ApiError && error.code === "SCANNER_UNAVAILABLE"
            ? t("hrisRequestsEmployee.leave.attachmentPhotoOnly")
            : "Lampiran gagal diunggah. Coba lagi.",
        );
        return;
      } finally {
        setUploading(false);
      }
    }
    onSubmit({
      payload,
      summary: {
        bodyKey: "hrisRequestsEmployee.success.bodyLeave",
        title: selected?.name ?? "",
        period:
          payload.startDate === payload.endDate
            ? formatBusinessDate(payload.startDate)
            : `${formatBusinessDate(payload.startDate)} – ${formatBusinessDate(payload.endDate)}`,
        reason: payload.reason,
      },
    });
  }

  if (typesQuery.isPending || balancesQuery.isPending) return <FormLoading />;
  if (typesQuery.isError || balancesQuery.isError)
    return (
      <FormLoading
        error
        onRetry={() => {
          void typesQuery.refetch();
          void balancesQuery.refetch();
        }}
      />
    );

  return (
    <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
      {selected && (
        <div
          className="grid gap-0.5 rounded-container bg-surface-2 px-4 py-3"
          aria-live="polite"
        >
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hrisRequestsEmployee.leave.balanceTitle")}
          </p>
          {remaining === null ? (
            <p className="font-semibold">
              {t("hrisRequestsEmployee.leave.balanceUnlimited")}
            </p>
          ) : (
            <p className="flex items-baseline gap-1">
              <span className="font-brand type-title tabular">
                {t("hrisRequestsEmployee.leave.balanceValue", {
                  days: formatDays(remaining),
                })}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("hrisRequestsEmployee.leave.balanceSuffix")}
              </span>
            </p>
          )}
        </div>
      )}

      <FormField
        label={t("hrisRequestsEmployee.leave.typeLabel")}
        error={errors.leaveTypeId ? t(errors.leaveTypeId) : undefined}
        required
      >
        <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
          <SelectTrigger>
            <SelectValue
              placeholder={t("hrisRequestsEmployee.leave.typePlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {types.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.leave.startLabel")}
        error={errors.startDate ? t(errors.startDate) : undefined}
        required
      >
        <Input
          type="date"
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
        />
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.leave.endLabel")}
        hint={
          days !== null
            ? t("hrisRequestsEmployee.leave.daysSummary", { count: days })
            : undefined
        }
        error={errors.endDate ? t(errors.endDate) : undefined}
        required
      >
        <Input
          type="date"
          min={startDate || undefined}
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
        />
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.leave.reasonLabel")}
        error={errors.reason ? t(errors.reason) : undefined}
        required
      >
        <Textarea
          value={reason}
          maxLength={REASON_MAX}
          placeholder={t("hrisRequestsEmployee.leave.reasonPlaceholder")}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      {overBalance && (
        <p
          role="status"
          className="flex items-start gap-2 text-sm leading-5 text-warning"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("hrisRequestsEmployee.leave.overBalance")}
        </p>
      )}
      <FormField
        label={t("hrisRequestsEmployee.leave.attachmentLabel")}
        required={selected?.requiresAttachment}
        error={fileError || undefined}
        hint={t(
          documentsAccepted
            ? "hrisRequestsEmployee.leave.attachmentHint"
            : "hrisRequestsEmployee.leave.attachmentPhotosHint",
        )}
      >
        <Input
          type="file"
          accept={
            documentsAccepted
              ? "application/pdf,image/jpeg,image/png,image/webp"
              : "image/jpeg,image/png,image/webp"
          }
          onChange={(event) => {
            const next = event.target.files?.[0] ?? null;
            if (next && isLeavePdf(next) && !documentsAccepted) {
              setFile(null);
              event.target.value = "";
              setFileError(t("hrisRequestsEmployee.leave.attachmentPhotoOnly"));
              return;
            }
            setFile(next);
            setFileError("");
          }}
        />
      </FormField>

      {failed && <SubmitFailure />}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={busy || uploading}
        disabled={busy || uploading}
      >
        {busy
          ? t("hrisRequestsEmployee.form.submitting")
          : t("hrisRequestsEmployee.form.submit")}
      </Button>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("hrisRequestsEmployee.form.submitHint")}
      </p>
    </form>
  );
}
