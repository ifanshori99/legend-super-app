// PRD §3.37 "Kebijakan Distribusi": the basis is fixed to a closed period's net
// profit (SH-02), and the reserve, frequency and withholding are the entity's
// configurable policy. Read-only summary plus one update dialog.
import * as React from "react";
import { Settings2 } from "lucide-react";
import {
  distributionFrequencySchema,
  type DistributionFrequency,
  type ProfitEntity,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useUpdateProfitEntity } from "../hooks";
import {
  FREQUENCY_KEYS,
  POLICY_BASIS_KEY,
  formatShareBp,
  parseShareBpInput,
} from "../lib";

const FREQUENCIES = Object.keys(FREQUENCY_KEYS) as DistributionFrequency[];

export function PolicyCard({
  entity,
  canWrite,
}: {
  entity: ProfitEntity;
  canWrite: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <CardShell>
        <CardShellBody>
          <div className="flex flex-wrap items-start justify-between gap-2 border-b p-card">
            <div className="grid gap-1">
              <h2 className="type-title">
                {t("accounting.share.policy.title")}
              </h2>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.share.policy.subtitle")}
              </p>
            </div>
            {canWrite && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
              >
                <Settings2 aria-hidden="true" />
                {t("accounting.share.policy.change")}
              </Button>
            )}
          </div>
          <dl className="grid gap-0 sm:grid-cols-2">
            <div className="grid gap-1 border-b p-card sm:border-r">
              <dt className="type-eyebrow text-muted-foreground">
                {t("accounting.share.policy.basis")}
              </dt>
              <dd className="text-sm font-medium">{t(POLICY_BASIS_KEY)}</dd>
            </div>
            <div className="grid gap-1 border-b p-card">
              <dt className="type-eyebrow text-muted-foreground">
                {t("accounting.share.policy.reserve")}
              </dt>
              <dd className="tabular text-sm font-medium">
                {formatShareBp(entity.policy.reserveBp)}
              </dd>
            </div>
            <div className="grid gap-1 border-b p-card sm:border-r sm:border-b-0">
              <dt className="type-eyebrow text-muted-foreground">
                {t("accounting.share.policy.frequency")}
              </dt>
              <dd className="text-sm font-medium">
                {t(FREQUENCY_KEYS[entity.policy.frequency])}
              </dd>
            </div>
            <div className="grid gap-1 p-card">
              <dt className="type-eyebrow text-muted-foreground">
                {t("accounting.share.policy.tax")}
              </dt>
              <dd className="tabular text-sm font-medium">
                {formatShareBp(entity.policy.taxWithholdingBp)}
              </dd>
            </div>
          </dl>
        </CardShellBody>
        <CardShellFooter>
          {t("accounting.share.policy.closedNote")}
        </CardShellFooter>
      </CardShell>
      <PolicyDialog open={open} onOpenChange={setOpen} entity={entity} />
    </>
  );
}

function PolicyDialog({
  open,
  onOpenChange,
  entity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: ProfitEntity;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <PolicyForm onOpenChange={onOpenChange} entity={entity} />
      </DialogContent>
    </Dialog>
  );
}

function PolicyForm({
  onOpenChange,
  entity,
}: {
  onOpenChange: (open: boolean) => void;
  entity: ProfitEntity;
}) {
  const t = useT();
  const frequencyFieldId = React.useId();
  const toast = useToast();
  const update = useUpdateProfitEntity(entity.id);
  const [reserveBp, setReserveBp] = React.useState(
    String(entity.policy.reserveBp),
  );
  const [taxBp, setTaxBp] = React.useState(
    String(entity.policy.taxWithholdingBp),
  );
  const [frequency, setFrequency] = React.useState<DistributionFrequency>(
    entity.policy.frequency,
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const pending = update.isPending;

  const submit = async () => {
    setServerError(null);
    setErrors({});
    const reserve = parseShareBpInput(reserveBp);
    const tax = parseShareBpInput(taxBp);
    if (reserve === null) {
      setErrors({ reserveBp: t("accounting.share.editor.bpInvalid") });
      return;
    }
    if (tax === null) {
      setErrors({ taxBp: t("accounting.share.editor.bpInvalid") });
      return;
    }
    try {
      await update.mutateAsync({
        policy: {
          basis: "closed_period_net_profit",
          reserveBp: reserve,
          frequency: distributionFrequencySchema.parse(frequency),
          taxWithholdingBp: tax,
        },
      });
      toast({ title: t("accounting.share.policy.saved") });
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.share.policy.dialogTitle")}</DialogTitle>
        <DialogDescription>
          {t("accounting.share.policy.closedNote")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.share.entityForm.reserve")}
            hint={t("accounting.share.policy.reserveHint")}
            error={errors.reserveBp}
            required
          >
            <Input
              value={reserveBp}
              onChange={(event) => setReserveBp(event.target.value)}
              inputMode="numeric"
              className="tabular"
            />
          </FormField>
          <FormField
            id={frequencyFieldId}
            label={t("accounting.share.entityForm.frequency")}
          >
            <Select
              value={frequency}
              onValueChange={(value) =>
                setFrequency(value as DistributionFrequency)
              }
            >
              <SelectTrigger id={frequencyFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((row) => (
                  <SelectItem key={row} value={row}>
                    {t(FREQUENCY_KEYS[row])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <FormField
          label={t("accounting.share.entityForm.tax")}
          hint={t("accounting.share.policy.taxHint")}
          error={errors.taxBp}
          required
        >
          <Input
            value={taxBp}
            onChange={(event) => setTaxBp(event.target.value)}
            inputMode="numeric"
            className="tabular"
          />
        </FormField>
        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
