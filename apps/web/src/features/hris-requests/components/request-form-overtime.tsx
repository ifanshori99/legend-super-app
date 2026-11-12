// "Lembur" tab (mockup lembur-mobile): date, start/end time, reason. The
// contract takes minutes (1-720), so the two times become a duration; there is
// no attachment field on overtime requests, so none is shown.
import { useState, type FormEvent } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatBusinessDate } from "@/features/ws10-payslip/format";
import { useTenantContext } from "@/lib/tenant-context";
import {
  overtimeMinutes,
  REASON_MAX,
  validateOvertime,
  type OvertimeErrors,
  type OvertimePayload,
} from "./request-form-logic.ts";
import { SubmitFailure } from "./request-form-loading.tsx";
import type { RequestSummary } from "./request-form-states.tsx";

export type OvertimeSubmit = {
  payload: OvertimePayload;
  summary: RequestSummary;
};

export function RequestFormOvertime({
  busy,
  failed,
  onSubmit,
}: {
  busy: boolean;
  failed: boolean;
  onSubmit: (request: OvertimeSubmit) => void;
}) {
  const t = useT();
  const { outlet } = useTenantContext();
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<OvertimeErrors>({});
  const minutes = overtimeMinutes(startTime, endTime);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { errors: next, payload } = validateOvertime(
      { date, startTime, endTime, reason },
      outlet?.id,
    );
    setErrors(next);
    if (!payload) return;
    onSubmit({
      payload,
      summary: {
        bodyKey: "hrisRequestsEmployee.success.bodyOvertime",
        title: t("hrisRequestsEmployee.form.tabOvertime"),
        period: `${formatBusinessDate(payload.date)} · ${startTime.replace(":", ".")}–${endTime.replace(":", ".")}`,
        reason: payload.reason,
      },
    });
  }

  return (
    <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
      <FormField
        label={t("hrisRequestsEmployee.overtime.dateLabel")}
        error={errors.date ? t(errors.date) : undefined}
        required
      >
        <Input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.overtime.startLabel")}
        error={errors.startTime ? t(errors.startTime) : undefined}
        required
      >
        <Input
          type="time"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
        />
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.overtime.endLabel")}
        hint={
          minutes !== null
            ? t("hrisRequestsEmployee.overtime.durationSummary", {
                hours: Math.floor(minutes / 60),
                minutes: minutes % 60,
              })
            : undefined
        }
        error={errors.endTime ? t(errors.endTime) : undefined}
        required
      >
        <Input
          type="time"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
        />
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.overtime.reasonLabel")}
        error={errors.reason ? t(errors.reason) : undefined}
        required
      >
        <Textarea
          value={reason}
          maxLength={REASON_MAX}
          placeholder={t("hrisRequestsEmployee.overtime.reasonPlaceholder")}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      {!outlet && (
        <p role="status" className="text-sm leading-5 text-warning">
          {t("hrisRequestsEmployee.overtime.noOutlet")}
        </p>
      )}
      {failed && <SubmitFailure />}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={busy}
        disabled={!outlet}
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
