// Create-run dialog (Alur K step 1): the period's reference date, the legal
// entity and policy the run uses, plus the idempotency key minted for this
// attempt. A run's policy is not a free choice in this screen: the payroll
// policy list belongs to the payroll-configuration bead, so the dialog offers
// the policies the existing runs already name and says so when there is none.
import * as React from "react";
import { CalendarPlus } from "lucide-react";
import { businessDateSchema } from "@starter/shared/core";
import { businessDateOf, DEFAULT_BUSINESS_DAY_CUTOFF } from "@starter/shared/core";
import type { PayrollRun } from "@starter/shared/hris/payroll";
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
import { newIdempotencyKey } from "../../../lib/idempotency.ts";
import { payrollErrorMessage } from "../errors";
import { useCreateRun } from "../hooks";
import { legalEntitiesOf, shortId, sortRuns } from "../lib";
import { PAYROLL_TIME_ZONE } from "../outlet";

type RunType = "regular" | "off_cycle";

export function CreateRunDialog({
  runs,
  open,
  onOpenChange,
  onCreated,
}: {
  runs: readonly PayrollRun[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (run: PayrollRun) => void;
}) {
  const t = useT();
  const toast = useToast();
  const createRun = useCreateRun();

  const entities = React.useMemo(
    () => legalEntitiesOf(sortRuns(runs)),
    [runs],
  );
  const [legalEntityId, setLegalEntityId] = React.useState(
    entities[0]?.legalEntityId ?? "",
  );
  const policyIds =
    entities.find((entity) => entity.legalEntityId === legalEntityId)
      ?.policyIds ?? [];
  const [policyId, setPolicyId] = React.useState(policyIds[0] ?? "");
  const [referenceDate, setReferenceDate] = React.useState(() =>
    businessDateOf(new Date(), {
        timeZone: PAYROLL_TIME_ZONE,
        cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
      }),
  );
  const [runType, setRunType] = React.useState<RunType>("regular");
  const [error, setError] = React.useState<string | null>(null);
  // One key per dialog attempt: a double submit creates one run, not two.
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  React.useEffect(() => {
    setLegalEntityId((current) =>
      entities.some((entity) => entity.legalEntityId === current)
        ? current
        : (entities[0]?.legalEntityId ?? ""),
    );
  }, [entities]);

  React.useEffect(() => {
    setPolicyId((current) =>
      policyIds.includes(current) ? current : (policyIds[0] ?? ""),
    );
  }, [policyIds]);

  const hasSource = entities.length > 0 && policyId !== "";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsedDate = businessDateSchema.safeParse(referenceDate);
    if (!parsedDate.success) {
      setError(t("payrollRun.create.dateInvalid"));
      return;
    }
    createRun.mutate(
      {
        payrollPolicyId: policyId as PayrollRun["payrollPolicyId"],
        runType,
        referenceDate: parsedDate.data,
        thrScheduleId: null,
        idempotencyKey,
      },
      {
        onSuccess: (run) => {
          toast({
            title: t("payrollRun.create.created"),
            tone: "success",
          });
          onCreated(run);
        },
        onError: (cause) => setError(payrollErrorMessage(cause, t)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("payrollRun.create.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollRun.create.description")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("payrollRun.create.referenceDate")}
            hint={t("payrollRun.create.referenceDateHint")}
            required
          >
            <Input
              type="date"
              value={referenceDate}
              onChange={(event) => setReferenceDate(event.target.value)}
            />
          </FormField>

          {hasSource ? (
            <>
              <FormField
                label={t("payrollRun.create.legalEntity")}
                hint={t("payrollRun.create.legalEntityHint")}
                required
              >
                <Select
                  value={legalEntityId}
                  onValueChange={setLegalEntityId}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {entities.map((entity) => (
                      <SelectItem
                        key={entity.legalEntityId}
                        value={entity.legalEntityId}
                      >
                        {t("payrollRun.create.legalEntityOption", {
                          id: shortId(entity.legalEntityId),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t("payrollRun.create.policy")}
                hint={t("payrollRun.create.policyHint")}
                required
              >
                <Select value={policyId} onValueChange={setPolicyId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {policyIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {t("payrollRun.create.policyOption", {
                          id: shortId(id),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </>
          ) : (
            <p className="rounded-container bg-warning-subtle p-3 text-sm leading-5 font-medium text-warning">
              {t("payrollRun.create.noPolicy")}
            </p>
          )}

          <FormField label={t("payrollRun.create.runType")} required>
            <Select
              value={runType}
              onValueChange={(value) => setRunType(value as RunType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="regular">
                  {t("payrollRun.runType.regular")}
                </SelectItem>
                <SelectItem value="off_cycle">
                  {t("payrollRun.runType.offCycle")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label={t("payrollRun.create.idempotencyKey")}
            hint={t("payrollRun.create.idempotencyHint")}
          >
            <Input value={idempotencyKey} readOnly className="tabular" />
          </FormField>

          {error && (
            <p role="alert" className="text-sm leading-5 font-medium text-danger">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!hasSource}
              loading={createRun.isPending}
            >
              <CalendarPlus aria-hidden="true" />
              {t("payrollRun.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
