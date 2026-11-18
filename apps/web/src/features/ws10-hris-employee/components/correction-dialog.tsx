// "Koreksi absensi" (PRD F25 "Koreksi Absensi", §4 Alur L): the employee
// proposes the corrected time with a reason and a supervisor decides. The body
// is validated with the contract's own schema before it is sent, so the form
// and the API agree and the reason limit is not duplicated in the UI.
//
// The form is its own component: Radix unmounts the dialog content when it
// closes, so every opening starts from the row it was opened for (no reset
// effect, no stale reason from the previous correction).
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
import { useMyEmployeeId, useSubmitCorrection } from "../hooks.ts";
import { canActOnQueued } from "../identity.ts";
import {
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  typeLabelKey,
} from "../state.ts";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";
import { CorrectionQueueFullError, type QueuedCorrection } from "../queue.ts";
import { ApiError } from "@/lib/api/errors";

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
  timeZone,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The log being corrected; null when the log is missing entirely. */
  log: AttendanceLog | null;
  outletId: string;
  /** The outlet's zone: the form edits the same clock the history shows. */
  timeZone: string;
  /**
   * A queued correction the server refused, reopened to fix and resend: the
   * form starts from its body and the old entry is replaced by the new
   * request once it is sent or queued, never before (legend-nvc7, legend-l5tvy).
   */
  editing?: QueuedCorrection;
}) {
  const t = useT();
  const toast = useToast();
  const employeeId = useMyEmployeeId();
  // The session may now name someone else than the entry's owner (another tab
  // signed in): the edit form closes instead of acting for the new account.
  const foreign = editing !== undefined && !canActOnQueued(editing, employeeId);
  useEffect(() => {
    if (foreign && open) onOpenChange(false);
  }, [foreign, open, onOpenChange]);

  return (
    <Dialog open={open && !foreign} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(editing ? "hris.correction.editTitle" : "hris.correction.title")}
          </DialogTitle>
          <DialogDescription>
            {t(editing ? "hris.correction.editHint" : "hris.correction.hint")}
          </DialogDescription>
        </DialogHeader>
        <CorrectionForm
          key={editing?.key ?? log?.id ?? "unmatched"}
          log={log}
          outletId={outletId}
          timeZone={timeZone}
          editing={editing}
          onSent={(status) => {
            toast(
              status === "queued"
                ? {
                    title: t("hris.correction.queuedTitle"),
                    description: t("hris.correction.queued"),
                  }
                : { title: t("hris.correction.success"), tone: "success" },
            );
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function CorrectionForm({
  log,
  outletId,
  timeZone,
  editing,
  onSent,
}: {
  log: AttendanceLog | null;
  outletId: string;
  timeZone: string;
  editing?: QueuedCorrection;
  onSent: (status: "sent" | "queued") => void;
}) {
  const t = useT();
  const submit = useSubmitCorrection();
  const employeeId = useMyEmployeeId();
  // One key per distinct request: a resend of the same body reuses it (the
  // API answers the first correction); an edited body gets a fresh key, since
  // a reused key with a different body is IDEMPOTENCY_KEY_REUSED (409).
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const [type, setType] = useState<AttendanceType>(
    editing?.body.requestedType ?? log?.type ?? "in",
  );
  const [occurredAt, setOccurredAt] = useState(() =>
    toDateTimeLocalValue(
      editing
        ? new Date(editing.body.requestedOccurredAt)
        : log
          ? new Date(log.occurredAt)
          : new Date(),
      timeZone,
    ),
  );
  const [reason, setReason] = useState(editing?.body.reason ?? "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function handleSend() {
    const expectedEmployeeId =
      editing?.employeeId ?? log?.employeeId ?? employeeId;
    if (expectedEmployeeId === null) {
      setFormError(t("hris.correction.identityMismatch"));
      return;
    }
    const occurredAtIso = fromDateTimeLocalValue(occurredAt, timeZone);
    if (occurredAtIso === null) {
      setErrors({ requestedOccurredAt: t("hris.correction.timeInvalid") });
      return;
    }
    const request = {
      outletId,
      expectedEmployeeId,
      attendanceLogId: editing
        ? (editing.body.attendanceLogId ?? null)
        : (log?.id ?? null),
      requestedType: type,
      requestedOccurredAt: occurredAtIso,
      reason: reason.trim(),
    };
    const fingerprint = JSON.stringify(request);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newIdempotencyKey() };
    const parsed = bodySchema.safeParse({
      ...request,
      idempotencyKey: attempt.current.key,
    });
    if (!parsed.success) {
      const mapped = fieldErrors(parsed.error);
      setErrors(mapped);
      // A refinement without a field path must still reach the employee.
      setFormError(
        Object.values(mapped).some(Boolean)
          ? null
          : t("hris.correction.invalid"),
      );
      return;
    }
    setErrors({});
    setFormError(null);
    submit.mutate(
      { body: parsed.data, replaces: editing?.key },
      {
        onSuccess: (result) => onSent(result.status),
      },
    );
  }

  return (
    <>
      <div className="grid gap-4">
        {log === null && !editing && (
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

        {formError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {formError}
          </p>
        )}

        {submit.isError && (
          <div role="alert" className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold text-danger">
              {t("hris.correction.errorTitle")}
            </p>
            <p className="text-sm leading-5">
              {submit.error instanceof CorrectionQueueFullError
                ? t("hris.correction.queueFull")
                : submit.error instanceof ApiError &&
                    (submit.error.code ===
                      "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH" ||
                      submit.error.code === "IDENTITY_CHANGED")
                  ? t("hris.correction.identityMismatch")
                  : submit.error instanceof Error
                    ? submit.error.message
                    : t("hris.correction.errorTitle")}
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
        <Button type="button" loading={submit.isPending} onClick={handleSend}>
          {submit.isPending
            ? t("hris.correction.submitting")
            : t("hris.correction.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}
