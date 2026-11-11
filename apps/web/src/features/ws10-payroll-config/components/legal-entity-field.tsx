// Legal-entity picker for the first payroll policy / THR schedule (bead wpqs).
// The list comes from the organisation contract, so a tenant with no policy
// yet can still choose the entity. It shows its own loading, empty (with a
// link to the organisation settings) and error (with retry) states; the form
// reads `blocked` to keep the save button off until an entity can be chosen.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import type { LegalEntity } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePayrollLegalEntities } from "../hooks";

type LegalEntityChoice = {
  /** Chosen entity id; "" until picked (a lone entity is picked for you). */
  legalEntityId: LegalEntity["id"] | "";
  /** True while the list cannot be used: loading, failed or empty. */
  blocked: boolean;
  field: React.ReactNode;
  select: (id: string) => void;
  /** Moves focus to the picker (first invalid field after a failed submit). */
  focus: () => void;
};

export const LEGAL_ENTITY_FIELD_ID = "payroll-legal-entity";

/**
 * @param preferredId an entity already used by an existing policy/schedule;
 * preselected when it is still in the list.
 */
export function useLegalEntityChoice({
  preferredId,
  emptyKey,
  error,
  disabled,
}: {
  preferredId: string | null;
  emptyKey: "legalEntity.emptyPolicy" | "legalEntity.emptyThr";
  error?: string;
  disabled?: boolean;
}): LegalEntityChoice {
  const t = useT();
  const query = usePayrollLegalEntities();
  const entities = query.data?.data ?? [];
  const [picked, setPicked] = React.useState("");

  const preferred = entities.find((entity) => entity.id === preferredId);
  const legalEntityId =
    entities.find((entity) => entity.id === picked)?.id ??
    preferred?.id ??
    (entities.length === 1 ? entities[0]?.id : undefined) ??
    "";

  const blocked = query.isPending || query.isError || entities.length === 0;
  const label = t("payrollConfig.legalEntity.label");

  let field: React.ReactNode;
  if (query.isPending) {
    field = (
      <div
        className="grid gap-1.5"
        aria-busy="true"
        data-testid="payroll-legal-entity-loading"
      >
        <p className="text-sm leading-5 text-muted-foreground" role="status">
          {t("payrollConfig.legalEntity.loading")}
        </p>
        <Skeleton className="h-control" />
      </div>
    );
  } else if (query.isError) {
    field = (
      <div
        className="grid gap-2 rounded-container border border-danger/40 bg-danger-subtle p-card"
        role="alert"
        data-testid="payroll-legal-entity-error"
      >
        <p className="text-sm leading-5 font-semibold text-danger">
          {t("payrollConfig.legalEntity.errorTitle")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollConfig.legalEntity.errorHint")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t("payrollConfig.legalEntity.retry")}
        </Button>
      </div>
    );
  } else if (entities.length === 0) {
    field = (
      <div
        className="grid gap-2 rounded-container border bg-surface-2 p-card"
        data-testid="payroll-legal-entity-empty"
      >
        <p className="text-sm leading-5 font-semibold">
          {t("payrollConfig.legalEntity.emptyTitle")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(`payrollConfig.${emptyKey}`)}
        </p>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="justify-self-start"
        >
          <Link to="/kelola/organisasi">
            {t("payrollConfig.legalEntity.emptyLink")}
          </Link>
        </Button>
      </div>
    );
  } else {
    field = (
      <FormField
        id={LEGAL_ENTITY_FIELD_ID}
        label={label}
        required
        hint={t("payrollConfig.legalEntity.hint")}
        error={error}
      >
        <Select
          value={legalEntityId}
          onValueChange={setPicked}
          disabled={disabled}
        >
          <SelectTrigger data-testid="payroll-legal-entity-select">
            <SelectValue
              placeholder={t("payrollConfig.legalEntity.placeholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {entities.map((entity) => (
              <SelectItem key={entity.id} value={entity.id}>
                {entity.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    );
  }

  return {
    legalEntityId,
    blocked,
    field,
    select: setPicked,
    focus: () => document.getElementById(LEGAL_ENTITY_FIELD_ID)?.focus(),
  };
}
