// "Umum" tab: the facility row itself — identity, session/cleaning/arrival
// minutes, overtime policy, operating hours per day and the cancellation /
// no-show policy (PRD v1.7 §3 F25 "Konfigurasi Legend", "Pembatalan").
// The contract facility DTO has no description field, so this screen does not
// invent one (reported as a decision).
import * as React from "react";
import type {
  CancellationResolution,
  Facility,
  FacilityType,
} from "@starter/shared/facility";
import {
  isFacilityTypeReleased,
  updateFacilitySchema,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  isStaleStampStatus,
  shouldRefillAfterConflict,
} from "../admin-conflict.ts";
import { useUpdateFacility } from "../hooks.ts";
import {
  clockMinutes,
  dayLongKeys,
  dayShortKeys,
  facilityTypeLabel,
  hoursToRows,
  parseInteger,
  parseUpdateDraft,
  resolutionLabel,
  rowsToHours,
  summarizeOperatingHours,
  type DayRow,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

type GeneralValues = {
  name: string;
  type: FacilityType;
  sessionMinutes: string;
  cleaningMinutes: string;
  arrivalGraceMinutes: string;
  overtimeGrace: string;
  overtimeBlock: string;
  overtimeFee: string;
  days: DayRow[];
  cancelBefore: string;
  lateResolution: CancellationResolution;
  lateFee: string;
  noShowResolution: CancellationResolution;
};

const RESOLUTIONS: readonly CancellationResolution[] = [
  "entitlement_restored",
  "refund_full",
  "refund_partial",
  "no_refund",
];

const FACILITY_TYPES: readonly FacilityType[] = [
  "shower",
  "locker",
  "meeting_room",
  "coworking",
];

function initialValues(facility: Facility): GeneralValues {
  return {
    name: facility.name,
    type: facility.type,
    sessionMinutes: String(facility.sessionMinutes),
    cleaningMinutes: String(facility.cleaningMinutes),
    arrivalGraceMinutes: String(facility.arrivalGraceMinutes),
    overtimeGrace: String(facility.overtimePolicy.graceMinutes),
    overtimeBlock: String(facility.overtimePolicy.blockMinutes),
    overtimeFee: String(facility.overtimePolicy.feePerBlockIdr),
    days: hoursToRows(facility.operatingHours),
    cancelBefore: String(facility.cancellationPolicy.freeCancelMinutesBefore),
    lateResolution: facility.cancellationPolicy.lateCancelResolution,
    lateFee: String(facility.cancellationPolicy.lateCancelFeeIdr),
    noShowResolution: facility.cancellationPolicy.noShowResolution,
  };
}

export function GeneralTab({
  facilityId,
  facility,
}: {
  facilityId: string;
  facility: Facility;
}) {
  const t = useT();
  const toast = useToast();
  const updateFacility = useUpdateFacility(facilityId);
  const [values, setValues] = React.useState<GeneralValues>(() =>
    initialValues(facility),
  );
  // The stamp of the row the form was filled from, not of the latest refetch:
  // a refetch swaps `facility` while the form keeps the old values, so saving
  // with the new stamp would overwrite another admin's edit. Advances only
  // after our own save, or after a conflict once the refetch brought a newer
  // row (see the conflict reset below).
  const [stamp, setStamp] = React.useState(facility.updatedAt);
  const [conflictPending, setConflictPending] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [hoursErrors, setHoursErrors] = React.useState<Record<number, string>>(
    {},
  );
  const [formError, setFormError] = React.useState<string>();

  // After a 412 the hook refetches the config. Once the refetched row
  // differs from the one the form was filled from, refill the form and take
  // its stamp, or every retry would send the old stamp and fail again. Plain
  // refetches never get here, so unsaved edits survive them. Set during render
  // (React's "adjust state when a prop changes" pattern), not in an effect.
  if (shouldRefillAfterConflict(conflictPending, facility.updatedAt, stamp)) {
    setConflictPending(false);
    setValues(initialValues(facility));
    setStamp(facility.updatedAt);
    setErrors({});
    setHoursErrors({});
  }

  const update = (patch: Partial<GeneralValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  const updateDay = (day: number, patch: Partial<DayRow>) =>
    setValues((current) => ({
      ...current,
      days: current.days.map((row, index) =>
        index === day ? { ...row, ...patch } : row,
      ),
    }));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const nextHours: Record<number, string> = {};

    const name = values.name.trim();
    if (name.length === 0)
      next.name = t("facilityAdmin.errors.required", {
        field: t("facilityAdmin.general.fieldsName"),
      });
    else if (name.length > 150)
      next.name = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.general.fieldsName"),
        max: 150,
      });

    const int = (
      raw: string,
      key: string,
      label: string,
      min: number,
      max: number,
    ): number | null => {
      const parsed = parseInteger(raw);
      if (parsed === null) {
        next[key] ??= t("facilityAdmin.errors.invalidNumber", { field: label });
        return null;
      }
      if (parsed < min || parsed > max) {
        next[key] ??= t("facilityAdmin.errors.range", {
          field: label,
          min,
          max,
        });
        return null;
      }
      return parsed;
    };

    const sessionMinutes = int(
      values.sessionMinutes,
      "sessionMinutes",
      t("facilityAdmin.general.fieldsSessionMinutes"),
      1,
      480,
    );
    const cleaningMinutes = int(
      values.cleaningMinutes,
      "cleaningMinutes",
      t("facilityAdmin.general.fieldsCleaningMinutes"),
      0,
      1440,
    );
    const arrivalGraceMinutes = int(
      values.arrivalGraceMinutes,
      "arrivalGraceMinutes",
      t("facilityAdmin.general.fieldsArrivalGraceMinutes"),
      0,
      1440,
    );
    const overtimeGrace = int(
      values.overtimeGrace,
      "overtimePolicy.graceMinutes",
      t("facilityAdmin.general.fieldsGraceMinutes"),
      0,
      1440,
    );
    const overtimeBlock = int(
      values.overtimeBlock,
      "overtimePolicy.blockMinutes",
      t("facilityAdmin.general.fieldsBlockMinutes"),
      1,
      120,
    );
    const overtimeFee = int(
      values.overtimeFee,
      "overtimePolicy.feePerBlockIdr",
      t("facilityAdmin.general.fieldsFeePerBlockIdr"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const cancelBefore = int(
      values.cancelBefore,
      "cancellationPolicy.freeCancelMinutesBefore",
      t("facilityAdmin.general.fieldsFreeCancelMinutesBefore"),
      0,
      1440,
    );
    const lateFee =
      values.lateResolution === "refund_partial"
        ? int(
            values.lateFee,
            "cancellationPolicy.lateCancelFeeIdr",
            t("facilityAdmin.general.fieldsLateCancelFeeIdr"),
            0,
            Number.MAX_SAFE_INTEGER,
          )
        : 0;

    // slotConfigSchema (contract): session + cleaning may not exceed 720 min.
    if (
      sessionMinutes !== null &&
      cleaningMinutes !== null &&
      sessionMinutes + cleaningMinutes > 720
    )
      next.cleaningMinutes = t("facilityAdmin.errors.slotTooLong");

    // PRD §3 F25 Pembatalan: a partial refund keeps a fee above zero.
    if (values.lateResolution === "refund_partial" && (lateFee ?? 0) <= 0)
      next["cancellationPolicy.lateCancelFeeIdr"] = t(
        "facilityAdmin.errors.partialFee",
      );

    // PRD §3 F25 Konfigurasi Legend: hours per day; FAC-06 rejects a slot
    // outside the operating hours, so a session that cannot fit is invalid.
    let openDays = 0;
    values.days.forEach((row, day) => {
      if (!row.enabled) return;
      openDays += 1;
      const open = clockMinutes(row.opensAt);
      const close = clockMinutes(row.closesAt);
      const dayName = t(dayLongKeys[day]);
      if (open === null || close === null) {
        nextHours[day] = t("facilityAdmin.errors.timeRequired");
        return;
      }
      if (close <= open) {
        nextHours[day] = t("facilityAdmin.errors.closeAfterOpen", {
          day: dayName,
        });
        return;
      }
      if (sessionMinutes !== null && close - open < sessionMinutes)
        nextHours[day] = t("facilityAdmin.errors.sessionOutsideHours", {
          day: dayName,
        });
    });
    if (openDays === 0) next.hours = t("facilityAdmin.errors.dayRequired");

    setErrors(next);
    setHoursErrors(nextHours);
    const issueCount = Object.keys(next).length + Object.keys(nextHours).length;
    if (issueCount > 0) {
      setFormError(t("form.errorSummary", { count: issueCount }));
      return;
    }
    setFormError(undefined);

    if (
      sessionMinutes === null ||
      cleaningMinutes === null ||
      arrivalGraceMinutes === null ||
      overtimeGrace === null ||
      overtimeBlock === null ||
      overtimeFee === null ||
      cancelBefore === null ||
      lateFee === null
    )
      return;

    const candidate = {
      name,
      type: values.type,
      sessionMinutes,
      cleaningMinutes,
      arrivalGraceMinutes,
      operatingHours: rowsToHours(values.days),
      overtimePolicy: {
        graceMinutes: overtimeGrace,
        blockMinutes: overtimeBlock,
        feePerBlockIdr: overtimeFee,
      },
      cancellationPolicy: {
        freeCancelMinutesBefore: cancelBefore,
        lateCancelResolution: values.lateResolution,
        lateCancelFeeIdr:
          values.lateResolution === "refund_partial" ? lateFee : 0,
        noShowResolution: values.noShowResolution,
      },
    };
    const parsed = parseUpdateDraft(updateFacilitySchema, candidate);
    if (!parsed.success) {
      setErrors((current) => ({
        ...current,
        ...zodFieldErrors(parsed.error),
      }));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }

    setConflictPending(false);
    updateFacility.mutate(
      { body: parsed.data, expectedUpdatedAt: stamp },
      {
        onSuccess: (saved) => {
          setStamp(saved.updatedAt);
          toast({ title: t("facilityAdmin.general.saved"), tone: "success" });
        },
        onError: (error) => {
          // Only a stale stamp (412) means another admin saved first. A 409
          // is a refused change, so the typed values stay for a retry.
          if (error instanceof ApiError && isStaleStampStatus(error.status))
            setConflictPending(true);
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("facilityAdmin.general.saveFailed"),
          );
        },
      },
    );
  }

  const hoursSummary = summarizeOperatingHours(
    rowsToHours(values.days),
    t,
  ).join("; ");

  return (
    <form onSubmit={submit} noValidate data-slot="facility-general-form">
      <div className="grid gap-5">
        <ConfigSection
          slot="facility-general-identity"
          title={t("facilityAdmin.general.sectionsIdentity")}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("facilityAdmin.general.fieldsName")}
              hint={t("facilityAdmin.general.hintsName")}
              error={errors.name}
              required
            >
              <Input
                value={values.name}
                onChange={(event) => update({ name: event.target.value })}
                autoComplete="off"
              />
            </FormField>
            <FormField label={t("facilityAdmin.general.fieldsType")} required>
              <Select
                value={values.type}
                onValueChange={(value) =>
                  update({ type: value as FacilityType })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FACILITY_TYPES.filter(isFacilityTypeReleased).map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(facilityTypeLabel[type])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        </ConfigSection>

        <ConfigSection
          slot="facility-general-duration"
          title={t("facilityAdmin.general.sectionsDuration")}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label={t("facilityAdmin.general.fieldsSessionMinutes")}
              hint={t("facilityAdmin.general.hintsSessionMinutes")}
              error={errors.sessionMinutes}
              required
            >
              <Input
                inputMode="numeric"
                value={values.sessionMinutes}
                onChange={(event) =>
                  update({ sessionMinutes: event.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsCleaningMinutes")}
              hint={t("facilityAdmin.general.hintsCleaningMinutes")}
              error={errors.cleaningMinutes}
              required
            >
              <Input
                inputMode="numeric"
                value={values.cleaningMinutes}
                onChange={(event) =>
                  update({ cleaningMinutes: event.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsArrivalGraceMinutes")}
              hint={t("facilityAdmin.general.hintsArrivalGraceMinutes")}
              error={errors.arrivalGraceMinutes}
              required
            >
              <Input
                inputMode="numeric"
                value={values.arrivalGraceMinutes}
                onChange={(event) =>
                  update({ arrivalGraceMinutes: event.target.value })
                }
              />
            </FormField>
          </div>
        </ConfigSection>

        <ConfigSection
          slot="facility-general-hours"
          title={t("facilityAdmin.general.sectionsHours")}
          description={t("facilityAdmin.general.hintsHours")}
        >
          <div className="grid gap-3">
            {values.days.map((row, day) => (
              <div
                key={day}
                data-slot="facility-day-row"
                className="grid gap-2 rounded-container border-(length:--border-w) border-border p-3"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-28 items-center gap-2 pb-2">
                    <Switch
                      id={`facility-day-${day}`}
                      checked={row.enabled}
                      onCheckedChange={(checked) =>
                        updateDay(day, { enabled: checked })
                      }
                      aria-label={t("facilityAdmin.general.fieldsOpenDay", {
                        day: t(dayLongKeys[day]),
                      })}
                    />
                    <Label htmlFor={`facility-day-${day}`}>
                      {t(dayLongKeys[day])}
                    </Label>
                  </div>
                  <FormField
                    label={t("facilityAdmin.general.fieldsOpensAt", {
                      day: t(dayShortKeys[day]),
                    })}
                    className="w-36"
                    required={row.enabled}
                  >
                    <Input
                      type="time"
                      aria-invalid={hoursErrors[day] ? true : undefined}
                      aria-describedby={
                        hoursErrors[day]
                          ? `facility-day-${day}-error`
                          : undefined
                      }
                      value={row.opensAt}
                      disabled={!row.enabled}
                      onChange={(event) =>
                        updateDay(day, { opensAt: event.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t("facilityAdmin.general.fieldsClosesAt", {
                      day: t(dayShortKeys[day]),
                    })}
                    className="w-36"
                    required={row.enabled}
                  >
                    <Input
                      type="time"
                      aria-invalid={hoursErrors[day] ? true : undefined}
                      aria-describedby={
                        hoursErrors[day]
                          ? `facility-day-${day}-error`
                          : undefined
                      }
                      value={row.closesAt}
                      disabled={!row.enabled}
                      onChange={(event) =>
                        updateDay(day, { closesAt: event.target.value })
                      }
                    />
                  </FormField>
                </div>
                {hoursErrors[day] && (
                  <p
                    id={`facility-day-${day}-error`}
                    className="text-sm leading-5 font-medium text-danger"
                  >
                    {hoursErrors[day]}
                  </p>
                )}
              </div>
            ))}
            {errors.hours && (
              <p className="text-sm leading-5 font-medium text-danger">
                {errors.hours}
              </p>
            )}
            <p className="text-sm leading-5 text-muted-foreground">
              {hoursSummary}
            </p>
          </div>
        </ConfigSection>

        <ConfigSection
          slot="facility-general-overtime"
          title={t("facilityAdmin.general.sectionsOvertime")}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label={t("facilityAdmin.general.fieldsGraceMinutes")}
              hint={t("facilityAdmin.general.hintsGraceMinutes")}
              error={errors["overtimePolicy.graceMinutes"]}
              required
            >
              <Input
                inputMode="numeric"
                value={values.overtimeGrace}
                onChange={(event) =>
                  update({ overtimeGrace: event.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsBlockMinutes")}
              hint={t("facilityAdmin.general.hintsBlockMinutes")}
              error={errors["overtimePolicy.blockMinutes"]}
              required
            >
              <Input
                inputMode="numeric"
                value={values.overtimeBlock}
                onChange={(event) =>
                  update({ overtimeBlock: event.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsFeePerBlockIdr")}
              hint={t("facilityAdmin.general.hintsFeePerBlockIdr")}
              error={errors["overtimePolicy.feePerBlockIdr"]}
              required
            >
              <Input
                inputMode="numeric"
                value={values.overtimeFee}
                onChange={(event) =>
                  update({ overtimeFee: event.target.value })
                }
              />
            </FormField>
          </div>
        </ConfigSection>

        <ConfigSection
          slot="facility-general-cancellation"
          title={t("facilityAdmin.general.sectionsCancellation")}
          description={t("facilityAdmin.general.hintsResolution")}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("facilityAdmin.general.fieldsFreeCancelMinutesBefore")}
              hint={t("facilityAdmin.general.hintsFreeCancelMinutesBefore")}
              error={errors["cancellationPolicy.freeCancelMinutesBefore"]}
              required
            >
              <Input
                inputMode="numeric"
                value={values.cancelBefore}
                onChange={(event) =>
                  update({ cancelBefore: event.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsLateCancelResolution")}
              required
            >
              <Select
                value={values.lateResolution}
                onValueChange={(value) => {
                  const resolution = value as CancellationResolution;
                  update({
                    lateResolution: resolution,
                    lateFee:
                      resolution === "refund_partial" ? values.lateFee : "0",
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map((resolution) => (
                    <SelectItem key={resolution} value={resolution}>
                      {t(resolutionLabel[resolution])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsLateCancelFeeIdr")}
              hint={t("facilityAdmin.general.hintsLateCancelFeeIdr")}
              error={errors["cancellationPolicy.lateCancelFeeIdr"]}
              required={values.lateResolution === "refund_partial"}
            >
              <Input
                inputMode="numeric"
                value={values.lateFee}
                disabled={values.lateResolution !== "refund_partial"}
                onChange={(event) => update({ lateFee: event.target.value })}
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.general.fieldsNoShowResolution")}
              required
            >
              <Select
                value={values.noShowResolution}
                onValueChange={(value) =>
                  update({
                    noShowResolution: value as CancellationResolution,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map((resolution) => (
                    <SelectItem key={resolution} value={resolution}>
                      {t(resolutionLabel[resolution])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        </ConfigSection>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={updateFacility.isPending}>
            {t("facilityAdmin.general.save")}
          </Button>
        </div>
        <FormError message={formError} />
      </div>
    </form>
  );
}
