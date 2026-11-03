// "Wi-Fi & WFC" tab: per-zone guest Wi-Fi policy — free minutes, spend bonus,
// peak-hour schedule, device cap, speed floor and the WFC minimum spend
// (PRD v1.7 §3 "Wi-Fi Tamu & WFC"; FAC-14: editable without a redeploy). The
// PUT contract replaces the whole policy, so the dialog edits every field.
import * as React from "react";
import type { FacilityConfig, WifiPolicy } from "@starter/shared/facility";
import {
  putWifiPolicySchema,
  wifiPolicySchema,
} from "@starter/shared/facility";
import { formatRupiah, type Translate } from "@starter/shared/i18n";
import { Plus, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { usePutWifiPolicy } from "../hooks.ts";
import {
  clockMinutes,
  dayShortKeys,
  parseInteger,
  shortId,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

type PeakDraft = {
  daysOfWeek: number[];
  startsAt: string;
  endsAt: string;
};

type TierDraft = { key: string; minutes: string };

type WifiDraft = {
  freeMinutes: string;
  peakFreeMinutes: string;
  spendPerExtraHourIdr: string;
  extraMinutes: string;
  maxDevices: string;
  baseSpeedKbps: string;
  fullSpeedKbps: string;
  minSpendEnabled: boolean;
  minSpendPerHourIdr: string;
  peakSchedule: PeakDraft[];
  tierBonus: TierDraft[];
};

type WifiDialogState = WifiPolicy | null;

function zoneLabel(policy: WifiPolicy, t: Translate): string {
  return policy.minSpendPerHourIdr === null
    ? t("facilityAdmin.wifi.zoneRegular")
    : t("facilityAdmin.wifi.zoneWfc");
}

function initialDraft(policy: WifiPolicy): WifiDraft {
  return {
    freeMinutes: String(policy.freeMinutes),
    peakFreeMinutes: String(policy.peakFreeMinutes),
    spendPerExtraHourIdr: String(policy.spendPerExtraHourIdr),
    extraMinutes: String(policy.extraMinutes),
    maxDevices: String(policy.maxDevices),
    baseSpeedKbps: String(policy.baseSpeedKbps),
    fullSpeedKbps: String(policy.fullSpeedKbps),
    minSpendEnabled: policy.minSpendPerHourIdr !== null,
    minSpendPerHourIdr: String(policy.minSpendPerHourIdr ?? 0),
    peakSchedule: policy.peakSchedule.map((window) => ({
      daysOfWeek: [...window.daysOfWeek],
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    })),
    tierBonus: Object.entries(policy.tierBonusMinutes).map(
      ([key, minutes]) => ({ key, minutes: String(minutes) }),
    ),
  };
}

export function WifiTab({
  facilityId,
  config,
}: {
  facilityId: string;
  config: FacilityConfig;
}) {
  const t = useT();
  const [dialog, setDialog] = React.useState<WifiDialogState>(null);
  const policies = [...config.wifiPolicies].sort((a, b) =>
    a.zoneId.localeCompare(b.zoneId),
  );

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-wifi"
        title={t("facilityAdmin.wifi.title")}
        description={t("facilityAdmin.wifi.description")}
      >
        {policies.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.wifi.empty")}
            description={t("facilityAdmin.wifi.emptyHint")}
          />
        ) : (
          <div className="grid gap-3">
            {policies.map((policy) => {
              const zone = zoneLabel(policy, t);
              return (
                <div
                  key={policy.id}
                  data-slot="wifi-policy"
                  data-policy-id={policy.id}
                  className="grid gap-3 rounded-container border-(length:--border-w) border-border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid gap-0.5">
                      <p className="font-semibold">{zone}</p>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("facilityAdmin.wifi.zoneLabel", {
                          id: shortId(policy.zoneId),
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t("facilityAdmin.wifi.edit", { zone })}
                      onClick={() => setDialog(policy)}
                    >
                      {t("facilityAdmin.common.edit")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="neutral">
                      {t("facilityAdmin.wifi.summaryFree", {
                        minutes: policy.freeMinutes,
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("facilityAdmin.wifi.summaryPeak", {
                        minutes: policy.peakFreeMinutes,
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("facilityAdmin.wifi.summarySpend", {
                        minutes: policy.extraMinutes,
                        amount: formatRupiah(policy.spendPerExtraHourIdr),
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("facilityAdmin.wifi.summaryDevices", {
                        count: policy.maxDevices,
                      })}
                    </Badge>
                    <Badge
                      tone={
                        policy.minSpendPerHourIdr === null ? "neutral" : "info"
                      }
                    >
                      {policy.minSpendPerHourIdr === null
                        ? t("facilityAdmin.wifi.summaryNoMinSpend")
                        : t("facilityAdmin.wifi.summaryMinSpend", {
                            amount: formatRupiah(policy.minSpendPerHourIdr),
                          })}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ConfigSection>

      {dialog && (
        <WifiDialog
          key={dialog.id}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          facilityId={facilityId}
          policy={dialog}
        />
      )}
    </div>
  );
}

function WifiDialog({
  open,
  onOpenChange,
  facilityId,
  policy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  policy: WifiPolicy;
}) {
  const t = useT();
  const toast = useToast();
  const putPolicy = usePutWifiPolicy(facilityId);
  const [draft, setDraft] = React.useState<WifiDraft>(() =>
    initialDraft(policy),
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [peakErrors, setPeakErrors] = React.useState<Record<number, string>>(
    {},
  );
  const [tierErrors, setTierErrors] = React.useState<Record<number, string>>(
    {},
  );
  const [formError, setFormError] = React.useState<string>();

  const update = (patch: Partial<WifiDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const updatePeak = (index: number, patch: Partial<PeakDraft>) =>
    setDraft((current) => ({
      ...current,
      peakSchedule: current.peakSchedule.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    }));

  const updateTier = (index: number, patch: Partial<TierDraft>) =>
    setDraft((current) => ({
      ...current,
      tierBonus: current.tierBonus.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    }));

  const zone =
    policy.minSpendPerHourIdr === null
      ? t("facilityAdmin.wifi.zoneRegular")
      : t("facilityAdmin.wifi.zoneWfc");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const nextPeaks: Record<number, string> = {};
    const nextTiers: Record<number, string> = {};

    const int = (
      raw: string,
      key: string,
      label: string,
      min: number,
      max: number,
    ): number | null => {
      const parsed = parseInteger(raw);
      if (parsed === null) {
        next[key] ??= t("facilityAdmin.errors.invalidNumber", {
          field: label,
        });
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

    const freeMinutes = int(
      draft.freeMinutes,
      "freeMinutes",
      t("facilityAdmin.wifi.fieldsFreeMinutes"),
      0,
      1440,
    );
    const peakFreeMinutes = int(
      draft.peakFreeMinutes,
      "peakFreeMinutes",
      t("facilityAdmin.wifi.fieldsPeakFreeMinutes"),
      0,
      1440,
    );
    const spendPerExtraHourIdr = int(
      draft.spendPerExtraHourIdr,
      "spendPerExtraHourIdr",
      t("facilityAdmin.wifi.fieldsSpendPerExtraHourIdr"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const extraMinutes = int(
      draft.extraMinutes,
      "extraMinutes",
      t("facilityAdmin.wifi.fieldsExtraMinutes"),
      1,
      1440,
    );
    const maxDevices = int(
      draft.maxDevices,
      "maxDevices",
      t("facilityAdmin.wifi.fieldsMaxDevices"),
      1,
      20,
    );
    const baseSpeedKbps = int(
      draft.baseSpeedKbps,
      "baseSpeedKbps",
      t("facilityAdmin.wifi.fieldsBaseSpeedKbps"),
      1,
      1_000_000,
    );
    const fullSpeedKbps = int(
      draft.fullSpeedKbps,
      "fullSpeedKbps",
      t("facilityAdmin.wifi.fieldsFullSpeedKbps"),
      1,
      1_000_000,
    );
    const minSpend = draft.minSpendEnabled
      ? int(
          draft.minSpendPerHourIdr,
          "minSpendPerHourIdr",
          t("facilityAdmin.wifi.fieldsMinSpendPerHour"),
          0,
          Number.MAX_SAFE_INTEGER,
        )
      : null;

    // wifiPolicySchema refinements (contract): peak allowance cannot exceed the
    // daily allowance, full speed must beat the base speed, and a zero spend
    // step would make extra minutes unlimited.
    if (
      freeMinutes !== null &&
      peakFreeMinutes !== null &&
      peakFreeMinutes > freeMinutes
    )
      next.peakFreeMinutes = t("facilityAdmin.errors.peakExceedsFree");
    if (spendPerExtraHourIdr !== null && spendPerExtraHourIdr <= 0)
      next.spendPerExtraHourIdr = t("facilityAdmin.errors.spendStep");
    if (
      baseSpeedKbps !== null &&
      fullSpeedKbps !== null &&
      fullSpeedKbps <= baseSpeedKbps
    )
      next.fullSpeedKbps = t("facilityAdmin.errors.speedOrder");

    draft.peakSchedule.forEach((window, index) => {
      if (window.daysOfWeek.length === 0) {
        nextPeaks[index] = t("facilityAdmin.errors.peakDaysRequired");
        return;
      }
      const start = clockMinutes(window.startsAt);
      const end = clockMinutes(window.endsAt);
      if (start === null || end === null) {
        nextPeaks[index] = t("facilityAdmin.errors.timeRequired");
        return;
      }
      if (end <= start)
        nextPeaks[index] = t("facilityAdmin.errors.peakEndAfterStart");
    });

    const seenKeys = new Set<string>();
    const tiers: { key: string; minutes: number }[] = [];
    draft.tierBonus.forEach((row, index) => {
      const key = row.key.trim();
      if (key.length === 0 || key.length > 30) {
        nextTiers[index] = t("facilityAdmin.errors.tierKeyLength");
        return;
      }
      if (seenKeys.has(key)) {
        nextTiers[index] = t("facilityAdmin.errors.tierKeyDuplicate");
        return;
      }
      seenKeys.add(key);
      const minutes = parseInteger(row.minutes);
      if (minutes === null || minutes > 720) {
        nextTiers[index] = t("facilityAdmin.errors.tierMinutes");
        return;
      }
      tiers.push({ key, minutes });
    });

    setErrors(next);
    setPeakErrors(nextPeaks);
    setTierErrors(nextTiers);
    const issueCount =
      Object.keys(next).length +
      Object.keys(nextPeaks).length +
      Object.keys(nextTiers).length;
    if (issueCount > 0) {
      setFormError(t("form.errorSummary", { count: issueCount }));
      return;
    }
    setFormError(undefined);
    if (
      freeMinutes === null ||
      peakFreeMinutes === null ||
      spendPerExtraHourIdr === null ||
      extraMinutes === null ||
      maxDevices === null ||
      baseSpeedKbps === null ||
      fullSpeedKbps === null ||
      (draft.minSpendEnabled && minSpend === null)
    )
      return;

    const body = {
      zoneId: policy.zoneId,
      freeMinutes,
      peakFreeMinutes,
      spendPerExtraHourIdr,
      extraMinutes,
      maxDevices,
      peakSchedule: draft.peakSchedule.map((window) => ({
        daysOfWeek: [...window.daysOfWeek].sort((a, b) => a - b),
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      })),
      baseSpeedKbps,
      fullSpeedKbps,
      minSpendPerHourIdr: draft.minSpendEnabled ? minSpend : null,
      tierBonusMinutes: Object.fromEntries(
        tiers.map((tier) => [tier.key, tier.minutes]),
      ),
    };
    const parsed = putWifiPolicySchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    // The PUT body has no cross-field refinements; the stored policy does.
    const stored = wifiPolicySchema.safeParse({
      ...parsed.data,
      id: policy.id,
      tenantId: policy.tenantId,
      outletId: policy.outletId,
    });
    if (!stored.success) {
      setErrors(zodFieldErrors(stored.error));
      setFormError(
        t("form.errorSummary", { count: stored.error.issues.length }),
      );
      return;
    }

    putPolicy.mutate(
      { policyId: policy.id, body: parsed.data },
      {
        onSuccess: () => {
          toast({
            title: t("facilityAdmin.wifi.updated"),
            tone: "success",
          });
          onOpenChange(false);
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("facilityAdmin.wifi.updateFailed"),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("facilityAdmin.wifi.dialogTitle", { zone })}
          </DialogTitle>
          <DialogDescription>
            {t("facilityAdmin.wifi.dialogHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-5">
          <section className="grid gap-3">
            <h3 className="type-heading">
              {t("facilityAdmin.wifi.sectionsQuota")}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("facilityAdmin.wifi.fieldsFreeMinutes")}
                error={errors.freeMinutes}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.freeMinutes}
                  onChange={(event) =>
                    update({ freeMinutes: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("facilityAdmin.wifi.fieldsPeakFreeMinutes")}
                error={errors.peakFreeMinutes}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.peakFreeMinutes}
                  onChange={(event) =>
                    update({ peakFreeMinutes: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("facilityAdmin.wifi.fieldsSpendPerExtraHourIdr")}
                hint={t("facilityAdmin.wifi.fieldsSpendPerExtraHourHint")}
                error={errors.spendPerExtraHourIdr}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.spendPerExtraHourIdr}
                  onChange={(event) =>
                    update({ spendPerExtraHourIdr: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("facilityAdmin.wifi.fieldsExtraMinutes")}
                error={errors.extraMinutes}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.extraMinutes}
                  onChange={(event) =>
                    update({ extraMinutes: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("facilityAdmin.wifi.fieldsMaxDevices")}
                error={errors.maxDevices}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.maxDevices}
                  onChange={(event) =>
                    update({ maxDevices: event.target.value })
                  }
                />
              </FormField>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="type-heading">
              {t("facilityAdmin.wifi.sectionsSpeed")}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("facilityAdmin.wifi.fieldsBaseSpeedKbps")}
                error={errors.baseSpeedKbps}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.baseSpeedKbps}
                  onChange={(event) =>
                    update({ baseSpeedKbps: event.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("facilityAdmin.wifi.fieldsFullSpeedKbps")}
                error={errors.fullSpeedKbps}
                required
              >
                <Input
                  inputMode="numeric"
                  value={draft.fullSpeedKbps}
                  onChange={(event) =>
                    update({ fullSpeedKbps: event.target.value })
                  }
                />
              </FormField>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="type-heading">
              {t("facilityAdmin.wifi.sectionsMinSpend")}
            </h3>
            <div className="flex items-start justify-between gap-3">
              <Label htmlFor="wifi-min-spend-enabled">
                {t("facilityAdmin.wifi.fieldsMinSpendEnabled")}
              </Label>
              <Switch
                id="wifi-min-spend-enabled"
                checked={draft.minSpendEnabled}
                onCheckedChange={(checked) =>
                  update({ minSpendEnabled: checked })
                }
              />
            </div>
            <FormField
              label={t("facilityAdmin.wifi.fieldsMinSpendPerHour")}
              error={errors.minSpendPerHourIdr}
              required={draft.minSpendEnabled}
            >
              <Input
                inputMode="numeric"
                disabled={!draft.minSpendEnabled}
                value={draft.minSpendPerHourIdr}
                onChange={(event) =>
                  update({ minSpendPerHourIdr: event.target.value })
                }
              />
            </FormField>
          </section>

          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="type-heading">
                {t("facilityAdmin.wifi.sectionsPeak")}
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    peakSchedule: [
                      ...draft.peakSchedule,
                      {
                        daysOfWeek: [1, 2, 3, 4, 5],
                        startsAt: "11:30",
                        endsAt: "14:00",
                      },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                {t("facilityAdmin.wifi.addPeak")}
              </Button>
            </div>
            {draft.peakSchedule.length === 0 ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("facilityAdmin.wifi.noPeak")}
              </p>
            ) : (
              draft.peakSchedule.map((window, index) => (
                <div
                  key={index}
                  data-slot="wifi-peak-window"
                  className="grid gap-2 rounded-container border-(length:--border-w) border-border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold">
                      {t("facilityAdmin.wifi.peakWindowTitle", {
                        index: index + 1,
                      })}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("facilityAdmin.wifi.removePeak", {
                        index: index + 1,
                      })}
                      onClick={() =>
                        update({
                          peakSchedule: draft.peakSchedule.filter(
                            (_, rowIndex) => rowIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  <div
                    role="group"
                    aria-label={t("facilityAdmin.wifi.peakDays", {
                      index: index + 1,
                    })}
                    className="flex flex-wrap gap-2"
                  >
                    {dayShortKeys.map((key, day) => (
                      <div key={key} className="flex items-center gap-1.5">
                        <Checkbox
                          id={`wifi-peak-${index}-day-${day}`}
                          checked={window.daysOfWeek.includes(day)}
                          onCheckedChange={(checked) =>
                            updatePeak(index, {
                              daysOfWeek:
                                checked === true
                                  ? [...window.daysOfWeek, day]
                                  : window.daysOfWeek.filter(
                                      (value) => value !== day,
                                    ),
                            })
                          }
                        />
                        <Label
                          htmlFor={`wifi-peak-${index}-day-${day}`}
                          className="font-normal"
                        >
                          {t(key)}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <FormField
                      label={t("facilityAdmin.wifi.peakStartsAt", {
                        index: index + 1,
                      })}
                      required
                    >
                      <Input
                        type="time"
                        aria-invalid={peakErrors[index] ? true : undefined}
                        aria-describedby={
                          peakErrors[index]
                            ? `wifi-peak-${index}-error`
                            : undefined
                        }
                        value={window.startsAt}
                        onChange={(event) =>
                          updatePeak(index, {
                            startsAt: event.target.value,
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t("facilityAdmin.wifi.peakEndsAt", {
                        index: index + 1,
                      })}
                      required
                    >
                      <Input
                        type="time"
                        aria-invalid={peakErrors[index] ? true : undefined}
                        aria-describedby={
                          peakErrors[index]
                            ? `wifi-peak-${index}-error`
                            : undefined
                        }
                        value={window.endsAt}
                        onChange={(event) =>
                          updatePeak(index, { endsAt: event.target.value })
                        }
                      />
                    </FormField>
                  </div>
                  {peakErrors[index] && (
                    <p
                      id={`wifi-peak-${index}-error`}
                      className="text-sm leading-5 font-medium text-danger"
                    >
                      {peakErrors[index]}
                    </p>
                  )}
                </div>
              ))
            )}
          </section>

          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="type-heading">
                {t("facilityAdmin.wifi.sectionsTier")}
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    tierBonus: [...draft.tierBonus, { key: "", minutes: "60" }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                {t("facilityAdmin.wifi.addTier")}
              </Button>
            </div>
            {draft.tierBonus.length === 0 ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("facilityAdmin.wifi.noTier")}
              </p>
            ) : (
              draft.tierBonus.map((tier, index) => (
                <div
                  key={index}
                  data-slot="wifi-tier-bonus"
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                >
                  <FormField label={t("facilityAdmin.wifi.tierKey")} required>
                    <Input
                      aria-invalid={tierErrors[index] ? true : undefined}
                      aria-describedby={
                        tierErrors[index]
                          ? `wifi-tier-${index}-error`
                          : undefined
                      }
                      value={tier.key}
                      onChange={(event) =>
                        updateTier(index, { key: event.target.value })
                      }
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("facilityAdmin.wifi.tierMinutes")}
                    required
                  >
                    <Input
                      inputMode="numeric"
                      aria-invalid={tierErrors[index] ? true : undefined}
                      aria-describedby={
                        tierErrors[index]
                          ? `wifi-tier-${index}-error`
                          : undefined
                      }
                      value={tier.minutes}
                      onChange={(event) =>
                        updateTier(index, { minutes: event.target.value })
                      }
                    />
                  </FormField>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("facilityAdmin.wifi.removeTier", {
                      tier: tier.key || index + 1,
                    })}
                    onClick={() =>
                      update({
                        tierBonus: draft.tierBonus.filter(
                          (_, rowIndex) => rowIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                  {tierErrors[index] && (
                    <p
                      id={`wifi-tier-${index}-error`}
                      className="text-sm leading-5 font-medium text-danger sm:col-span-3"
                    >
                      {tierErrors[index]}
                    </p>
                  )}
                </div>
              ))
            )}
          </section>

          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={putPolicy.isPending}>
              {t("facilityAdmin.wifi.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
