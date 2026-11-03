// Profit-entity context: an entity may be a legal entity or one outlet, because
// each outlet can have its own shareholders (PRD §3.37 "Entitas Bagi Hasil").
// The picker reads the profit-share contract, not the legal-entity picker: the
// list of distributable entities is its own endpoint.
import * as React from "react";
import { Plus } from "lucide-react";
import {
  createProfitEntityInputSchema,
  distributionFrequencySchema,
  type DistributionFrequency,
  type ProfitEntity,
  type ProfitEntityType,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useLegalEntities, useOutlets } from "@/features/ws07-accounting/hooks";
import { useCreateProfitEntity } from "../hooks";
import { FREQUENCY_KEYS, parseShareBpInput, profitEntityTypeKey } from "../lib";

const FREQUENCIES = Object.keys(FREQUENCY_KEYS) as DistributionFrequency[];

export function ProfitEntityPicker({
  entities,
  value,
  onChange,
  onAdd,
}: {
  entities: readonly Pick<ProfitEntity, "id" | "name" | "type">[];
  value: string | undefined;
  onChange: (profitEntityId: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const current = entities.find((entity) => entity.id === value) ?? entities[0];
  return (
    <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
      {entities.length === 1 && current ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.entityLabel")}:{" "}
          <span className="font-medium text-foreground">{current.name}</span>
          {" · "}
          <span>{t(profitEntityTypeKey(current))}</span>
        </p>
      ) : (
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="profit-entity">
            {t("accounting.share.entityLabel")}
          </Label>
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id="profit-entity" className="h-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entities.map((entity) => (
                <SelectItem key={entity.id} value={entity.id}>
                  {entity.name} · {t(profitEntityTypeKey(entity))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.share.entityHint")}
          </p>
        </div>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onAdd}>
        <Plus aria-hidden="true" />
        {t("accounting.share.entityAdd")}
      </Button>
    </div>
  );
}

type Values = {
  name: string;
  type: ProfitEntityType;
  sourceId: string;
  reserveBp: string;
  frequency: DistributionFrequency;
  taxBp: string;
};

export function ProfitEntityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Radix unmounts DialogContent on close, so the form re-seeds every opening.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ProfitEntityForm onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function ProfitEntityForm({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const typeFieldId = React.useId();
  const sourceFieldId = React.useId();
  const frequencyFieldId = React.useId();
  const toast = useToast();
  const create = useCreateProfitEntity();
  const legalEntities = useLegalEntities();
  const outlets = useOutlets();
  const [values, setValues] = React.useState<Values>({
    name: "",
    type: "legal_entity",
    sourceId: "",
    reserveBp: "1000",
    frequency: "quarterly",
    taxBp: "1000",
  });
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const sources =
    values.type === "legal_entity"
      ? (legalEntities.data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
        }))
      : (outlets.data ?? []).map((row) => ({ id: row.id, name: row.name }));

  const patch = (next: Partial<Values>) =>
    setValues((current) => ({ ...current, ...next }));

  const reserveBp = parseShareBpInput(values.reserveBp);
  const taxBp = parseShareBpInput(values.taxBp);
  const pending = create.isPending;

  const submit = async () => {
    setServerError(null);
    if (reserveBp === null) {
      setErrors({ reserveBp: t("accounting.share.editor.bpInvalid") });
      return;
    }
    if (taxBp === null) {
      setErrors({ taxBp: t("accounting.share.editor.bpInvalid") });
      return;
    }
    const result = createProfitEntityInputSchema.safeParse({
      name: values.name.trim(),
      type: values.type,
      legalEntityId: values.type === "legal_entity" ? values.sourceId : null,
      outletId: values.type === "outlet" ? values.sourceId : null,
      policy: {
        basis: "closed_period_net_profit",
        reserveBp,
        frequency: distributionFrequencySchema.parse(values.frequency),
        taxWithholdingBp: taxBp,
      },
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    try {
      await create.mutateAsync(result.data);
      toast({ title: t("accounting.share.entityForm.saved") });
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
        <DialogTitle>{t("accounting.share.entityCreateTitle")}</DialogTitle>
        <DialogDescription>
          {t("accounting.share.entityCreateDescription")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("accounting.share.entityForm.name")}
          error={errors.name}
          required
        >
          <Input
            value={values.name}
            onChange={(event) => patch({ name: event.target.value })}
            autoComplete="off"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={typeFieldId}
            label={t("accounting.share.entityForm.type")}
            required
          >
            <Select
              value={values.type}
              onValueChange={(type) =>
                patch({ type: type as ProfitEntityType, sourceId: "" })
              }
            >
              <SelectTrigger id={typeFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="legal_entity">
                  {t("accounting.share.entityTypes.legalEntity")}
                </SelectItem>
                <SelectItem value="outlet">
                  {t("accounting.share.entityTypes.outlet")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            id={sourceFieldId}
            label={t("accounting.share.entityForm.source")}
            hint={t("accounting.share.entityForm.sourceHint")}
            error={errors.outletId ?? errors.legalEntityId ?? errors.type}
            required
          >
            <Select
              value={values.sourceId}
              onValueChange={(sourceId) => patch({ sourceId })}
            >
              <SelectTrigger id={sourceFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label={t("accounting.share.entityForm.reserve")}
            hint={t("accounting.share.entityForm.reserveHint")}
            error={errors.reserveBp}
            required
          >
            <Input
              value={values.reserveBp}
              onChange={(event) => patch({ reserveBp: event.target.value })}
              inputMode="numeric"
              className="tabular"
            />
          </FormField>
          <FormField
            id={frequencyFieldId}
            label={t("accounting.share.entityForm.frequency")}
          >
            <Select
              value={values.frequency}
              onValueChange={(frequency) =>
                patch({ frequency: frequency as DistributionFrequency })
              }
            >
              <SelectTrigger id={frequencyFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((frequency) => (
                  <SelectItem key={frequency} value={frequency}>
                    {t(FREQUENCY_KEYS[frequency])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.share.entityForm.tax")}
            hint={t("accounting.share.entityForm.taxHint")}
            error={errors.taxBp}
            required
          >
            <Input
              value={values.taxBp}
              onChange={(event) => patch({ taxBp: event.target.value })}
              inputMode="numeric"
              className="tabular"
            />
          </FormField>
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.policy.closedNote")}
        </p>
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
            {t("accounting.share.entityForm.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
