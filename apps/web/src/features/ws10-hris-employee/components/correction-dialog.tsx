// "Koreksi absensi" (PRD F25 "Koreksi Absensi", §4 Alur L): the employee
// proposes the corrected time with a reason and a supervisor decides. The body
// is validated with the contract's own schema before it is sent, so the form
// and the API agree and the reason limit is not duplicated in the UI.
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { AttendanceLog, AttendanceType } from "@starter/shared/hris";
import { requestAttendanceCorrection } from "@starter/shared/hris";
import { useSubmitCorrection } from "../hooks.ts";
import {
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  typeLabelKey,
} from "../state.ts";

const TYPES: readonly AttendanceType[] = [
  "in",
  "break_start",
  "break_end",
  "out",
];

const bodySchema = requestAttendanceCorrection.body;

export function CorrectionDialog({
  open,
  onOpenChange,
  log,
  outletId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The log being corrected; null when the log is missing entirely. */
  log: AttendanceLog | null;
  outletId: string;
}) {
  const t = useT();
  const toast = useToast();
  const submit = useSubmitCorrection();
  const resetSubmit = submit.reset;
  const idempotencyKey = useRef<string>("");

  const [type, setType] = useState<AttendanceType>("in");
  const [occurredAt, setOccurredAt] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    if (!open) return;
    setType(log?.type ?? "in");
    setOccurredAt(
      toDateTimeLocalValue(log ? new Date(log.occurredAt) : new Date()),
    );
    setReason("");
    setErrors({});
    idempotencyKey.current = crypto.randomUUID();
    resetSubmit();
  }, [open, log, resetSubmit]);

  function handleSend() {
    const occurredAtIso = fromDateTimeLocalValue(occurredAt);
    if (occurredAtIso === null) {
      setErrors({ requestedOccurredAt: t("hris.correction.timeInvalid") });
      return;
    }
    if (idempotencyKey.current === "")
      idempotencyKey.current = crypto.randomUUID();
    const parsed = bodySchema.safeParse({
      outletId,
      attendanceLogId: log?.id ?? null,
      requestedType: type,
      requestedOccurredAt: occurredAtIso,
      reason: reason.trim(),
      idempotencyKey: idempotencyKey.current,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    submit.mutate(parsed.data, {
      onSuccess: (result) => {
        if (result.status === "queued")
          toast({
            title: t("hris.correction.queuedTitle"),
            description: t("hris.correction.queued"),
          });
        else
          toast({
            title: t("hris.correction.success"),
            tone: "success",
          });
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("hris.correction.title")}</DialogTitle>
          <DialogDescription>{t("hris.correction.hint")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {log === null && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("hris.correction.noLog")}
            </p>
          )}

          <FormField
            label={t("hris.correction.typeLabel")}
            required
            error={errors.requestedType}
          >
            <Select
              value={type}
              onValueChange={(value) => setType(value as AttendanceType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(typeLabelKey(option))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label={t("hris.correction.timeLabel")}
            required
            error={errors.requestedOccurredAt}
          >
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
          </FormField>

          <FormField
            label={t("hris.correction.reasonLabel")}
            hint={t("hris.correction.reasonHint")}
            required
            error={errors.reason}
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("hris.correction.reasonPlaceholder")}
              maxLength={500}
            />
          </FormField>

          {submit.isError && (
            <div role="alert" className="grid gap-0.5">
              <p className="text-sm leading-5 font-semibold text-danger">
                {t("hris.correction.errorTitle")}
              </p>
              <p className="text-sm leading-5">
                {submit.error instanceof Error
                  ? submit.error.message
                  : t("hris.correction.failed")}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("hris.correction.errorHint")}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("hris.correction.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            loading={submit.isPending}
            onClick={handleSend}
          >
            {submit.isPending
              ? t("hris.correction.submitting")
              : t("hris.correction.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
