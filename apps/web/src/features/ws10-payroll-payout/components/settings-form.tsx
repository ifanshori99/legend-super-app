// The payout settings form of one PT. UI checks only explain the form and
// grey the save button; the server decides, and its error is always shown.
import * as React from "react";
import { CircleAlert } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { PayrollPayoutConfigDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
import { payoutErrorKey } from "../errors";
import { useUpsertPayoutConfig } from "../hooks";
import { SettingsAside } from "./settings-aside";
import {
  buildInput,
  digitsOnly,
  draftFromConfig,
  draftsEqual,
  parseIdr,
  savedSourceInactive,
  validateDraft,
  type SettingsDraft,
  type SourceAccount,
} from "./settings-model";
import { SettingsStepUp } from "./settings-stepup";

function accountName(account: SourceAccount): string {
  return `${account.label} ${account.maskedNumber}`;
}

function RupiahField({
  label,
  hint,
  error,
  value,
  disabled,
  required = true,
  onChange,
}: {
  label: string;
  hint: string;
  error?: string;
  value: string;
  disabled: boolean;
  required?: boolean;
  onChange: (digits: string) => void;
}) {
  return (
    <FormField
      label={label}
      hint={hint}
      error={error}
      required={required}
      className="sm:row-span-4 sm:grid-rows-subgrid sm:gap-y-1.5"
    >
      <Input
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        className="tabular min-h-11"
        value={value === "" ? "" : formatNumber(Number(value))}
        onChange={(event) => onChange(digitsOnly(event.target.value))}
      />
    </FormField>
  );
}

export function SettingsForm({
  legalEntityId,
  entityName,
  config,
  accounts,
  accountsState,
  onRetryAccounts,
  canConfigure,
}: {
  legalEntityId: string;
  entityName: string | null;
  /** null: this PT has no payout settings yet. */
  config: PayrollPayoutConfigDto | null;
  accounts: readonly SourceAccount[];
  /** Source accounts are not judged until the list is ready. */
  accountsState: "loading" | "error" | "ready";
  onRetryAccounts: () => void;
  canConfigure: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const upsert = useUpsertPayoutConfig(legalEntityId);
  const initial = React.useMemo(() => draftFromConfig(config), [config]);
  const [draft, setDraft] = React.useState<SettingsDraft>(initial);
  const [attempted, setAttempted] = React.useState(false);
  const [stepUp, setStepUp] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);

  const accountsReady = accountsState === "ready";
  const known = accountsReady ? accounts : null;
  const inactiveSaved = savedSourceInactive(config, known);
  const problems = validateDraft(draft, known);
  const hardBlock =
    problems.source === "payrollPayoutSettings.source.inactiveError" ||
    problems.method !== undefined;
  const show = (key: keyof typeof problems) => {
    const problem = problems[key];
    if (!problem) return undefined;
    if (attempted || key === "method") return t(problem);
    if (key === "source" && hardBlock) return t(problem);
    return undefined;
  };
  const pristine = config !== null && draftsEqual(draft, initial);
  const canSave =
    canConfigure &&
    accountsReady &&
    !upsert.isPending &&
    !hardBlock &&
    !pristine;
  const savedAccount = accounts.find(
    (account) => account.id === config?.manualSourceBankAccountId,
  );
  const options = accounts.filter(
    (account) => account.active || account.id === draft.sourceId,
  );
  const noActive = accountsReady && !accounts.some((account) => account.active);

  const patch = (change: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setFailure(null);
  };

  const send = () => {
    if (upsert.isPending) return;
    setFailure(null);
    upsert.mutate(buildInput(draft, config), {
      onSuccess: () => {
        setStepUp(false);
        setAttempted(false);
        toast({
          title: t("payrollPayoutSettings.save.success"),
          tone: "success",
        });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === "MFA_REQUIRED") {
          setStepUp(true);
          return;
        }
        setStepUp(false);
        setFailure(error);
      },
    });
  };

  const save = () => {
    setAttempted(true);
    if (Object.keys(problems).length > 0) return;
    send();
  };

  const methodDuitku = draft.method === "duitku";
  const failureMessage =
    failure instanceof ApiError && failure.status < 500 && failure.message
      ? failure.message
      : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-4">
        {inactiveSaved && config && (
          <div
            role="alert"
            data-testid="payout-inactive-source"
            className="flex items-start gap-3 rounded-container border-(length:--border-w) border-danger bg-danger-subtle p-4 text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-5 shrink-0"
              aria-hidden="true"
            />
            <div className="grid gap-1">
              <p className="font-semibold">
                {t("payrollPayoutSettings.banner.title")}
              </p>
              <p className="text-sm">
                {savedAccount
                  ? t("payrollPayoutSettings.banner.body", {
                      account: accountName(savedAccount),
                    })
                  : t("payrollPayoutSettings.banner.bodyUnknown")}
              </p>
            </div>
          </div>
        )}

        <Card className="gap-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-0.5">
              <h3 className="type-title">{t("payrollPayoutSettings.title")}</h3>
              {entityName && (
                <p className="text-sm text-muted-foreground">{entityName}</p>
              )}
            </div>
            <Badge tone={config?.enabled ? "brand" : "neutral"}>
              {t(
                config?.enabled
                  ? config.method === "duitku"
                    ? "payrollPayoutSettings.badge.duitku"
                    : "payrollPayoutSettings.badge.manual"
                  : "payrollPayoutSettings.badge.off",
              )}
            </Badge>
          </div>

          {!canConfigure && (
            <p
              role="status"
              className="rounded-field bg-surface-2 p-3 text-sm text-muted-foreground"
            >
              {t("payrollPayoutSettings.readOnlyHint")}
            </p>
          )}

          <FormField
            label={t("payrollPayoutSettings.method.label")}
            hint={t("payrollPayoutSettings.method.hint")}
            error={show("method")}
            required
          >
            <Select
              value={draft.method}
              disabled={!canConfigure}
              onValueChange={(value) =>
                patch({ method: value === "duitku" ? "duitku" : "manual_bank" })
              }
            >
              <SelectTrigger className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual_bank">
                  {t("payrollPayoutSettings.method.manual")}
                </SelectItem>
                <SelectItem value="duitku" disabled>
                  {t("payrollPayoutSettings.method.duitku")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label={t("payrollPayoutSettings.source.label")}
            hint={
              accountsState === "loading"
                ? t("payrollPayoutSettings.source.loading")
                : accountsState === "error"
                  ? t("payrollPayoutSettings.source.loadError")
                  : noActive
                    ? t("payrollPayoutSettings.source.none")
                    : t("payrollPayoutSettings.source.hint")
            }
            error={show("source")}
            required
          >
            <Select
              value={draft.sourceId}
              disabled={!canConfigure || !accountsReady}
              onValueChange={(value) => patch({ sourceId: value })}
            >
              <SelectTrigger className="min-h-11">
                <SelectValue
                  placeholder={t("payrollPayoutSettings.source.placeholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((account) => (
                  <SelectItem
                    key={account.id}
                    value={account.id}
                    disabled={!account.active}
                  >
                    {accountName(account)}
                    {" · "}
                    {t(
                      account.active
                        ? "payrollPayoutSettings.source.active"
                        : "payrollPayoutSettings.source.inactive",
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {accountsState === "error" && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-fit"
              onClick={onRetryAccounts}
            >
              {t("payrollPayoutSettings.source.retry")}
            </Button>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <RupiahField
              label={t("payrollPayoutSettings.limits.perTransfer")}
              hint={t("payrollPayoutSettings.limits.perTransferHint")}
              error={show("maxPerTransfer")}
              value={draft.maxPerTransfer}
              disabled={!canConfigure}
              onChange={(maxPerTransfer) => patch({ maxPerTransfer })}
            />
            <RupiahField
              label={t("payrollPayoutSettings.limits.daily")}
              hint={t("payrollPayoutSettings.limits.dailyHint")}
              error={show("dailyCap")}
              value={draft.dailyCap}
              disabled={!canConfigure}
              required={false}
              onChange={(dailyCap) => patch({ dailyCap })}
            />
            <RupiahField
              label={t("payrollPayoutSettings.limits.fee")}
              hint={t("payrollPayoutSettings.limits.feeHint")}
              error={show("fee")}
              value={draft.fee}
              disabled={!canConfigure}
              onChange={(fee) => patch({ fee })}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-field bg-surface-2 p-3">
            <div className="grid gap-0.5">
              <label htmlFor="payout-enabled" className="text-sm font-semibold">
                {t("payrollPayoutSettings.enabled.label")}
              </label>
              <p className="text-sm text-muted-foreground">
                {t(
                  methodDuitku
                    ? "payrollPayoutSettings.enabled.hintDuitku"
                    : draft.enabled
                      ? "payrollPayoutSettings.enabled.hintOn"
                      : "payrollPayoutSettings.enabled.hintOff",
                )}
              </p>
            </div>
            <Switch
              id="payout-enabled"
              checked={draft.enabled && !methodDuitku}
              disabled={!canConfigure || methodDuitku}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          </div>

          <section
            aria-labelledby="payout-duitku-title"
            className="grid gap-2 border-t pt-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="payout-duitku-title" className="type-title">
                {t("payrollPayoutSettings.duitku.title")}
              </h4>
              <Badge tone="warning">
                {t("payrollPayoutSettings.duitku.status")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutSettings.duitku.body")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutSettings.duitku.credentialsNote")}
            </p>
          </section>

          {stepUp && (
            <SettingsStepUp saving={upsert.isPending} onVerified={send} />
          )}

          {failure !== null && (
            <div
              role="alert"
              data-testid="payout-settings-failure"
              className="grid gap-1 rounded-field border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
            >
              <p className="font-semibold">
                {t("payrollPayoutSettings.failure.title")}
              </p>
              <p>{t(payoutErrorKey(failure))}</p>
              {failureMessage && (
                <p>
                  {t("payrollPayoutSettings.failure.serverSays", {
                    message: failureMessage,
                  })}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {!accountsReady
                ? t(
                    accountsState === "loading"
                      ? "payrollPayoutSettings.save.accountsPending"
                      : "payrollPayoutSettings.save.accountsFailed",
                  )
                : pristine && !hardBlock
                  ? t("payrollPayoutSettings.save.pristine")
                  : t("payrollPayoutSettings.save.mfaHint")}
            </p>
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              loading={upsert.isPending}
              disabled={!canSave}
              onClick={save}
            >
              {t("payrollPayoutSettings.save.action")}
            </Button>
          </div>
        </Card>
      </div>

      <SettingsAside feeIdr={parseIdr(draft.fee)} entityName={entityName} />
    </div>
  );
}
