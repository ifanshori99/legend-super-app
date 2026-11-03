// Create-run dialog (Alur K step 1): the period's reference date, the legal
// entity and policy the run uses, plus the idempotency key minted for this
// attempt. A run's policy is not a free choice in this screen: the payroll
// policy list belongs to the payroll-configuration bead, so the dialog offers
// the policies the existing runs already name and says so when there is none.
import * as React from "react";
import { CalendarPlus } from "lucide-react";
import {
  businessDateOf,
  businessDateSchema,
  DEFAULT_BUSINESS_DAY_CUTOFF,
} from "@starter/shared/core";
import {
  payrollPolicyIdSchema,
  type PayrollRun,
} from "@starter/shared/hris/payroll";
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

  const entities = React.useMemo(() => legalEntitiesOf(sortRuns(runs)), [runs]);
  // Selection is derived, never copied into state by an effect: a run the
  // dialog has not seen yet falls back to the first entity and its policy.
  const [selectedEntityId, setSelectedEntityId] = React.useState("");
  const legalEntityId = entities.some(
    (entity) => entity.legalEntityId === selectedEntityId,
  )
    ? selectedEntityId
    : (entities[0]?.legalEntityId ?? "");
  const policyIds = React.useMemo(
    () =>
      entities.find((entity) => entity.legalEntityId === legalEntityId)
        ?.policyIds ?? [],
    [entities, legalEntityId],
  );
  const [selectedPolicyId, setSelectedPolicyId] = React.useState("");
  const policyId = policyIds.includes(selectedPolicyId)
    ? selectedPolicyId
    : (policyIds[0] ?? "");
  const [referenceDate, setReferenceDate] = React.useState(() =>
    businessDateOf(new Date(), {
      timeZone: PAYROLL_TIME_ZONE,
      cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
    }),
  );
  const [runType, setRunType] = React.useState<RunType>("regular");
  const [error, setError] = React.useState<string | null>(null);
  // One key per dialog attempt: a double submit creates one run, not two.
  // One key per attempt: a double submit or a retry after a lost response
  // replays the same write. A new key is minted once the attempt ends (success
  // or close), so the next run/pool is never refused as a reused key.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() =>
    newIdempotencyKey(),
  );
  function setOpen(next: boolean) {
    if (!next) setIdempotencyKey(newIdempotencyKey());
    onOpenChange(next);
  }

  const hasSource = entities.length > 0 && policyId !== "";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsedDate = businessDateSchema.safeParse(referenceDate);
    if (!parsedDate.success) {
      setError(t("payrollRun.create.dateInvalid"));
      return;
    }
    const parsedPolicy = payrollPolicyIdSchema.safeParse(policyId);
    if (!parsedPolicy.success) {
      setError(t("payrollRun.create.noPolicy"));
      return;
    }
    createRun.mutate(
      {
        payrollPolicyId: parsedPolicy.data,
        runType,
        referenceDate: parsedDate.data,
        thrScheduleId: null,
        idempotencyKey,
      },
      {
        onSuccess: (run) => {
          setIdempotencyKey(newIdempotencyKey());
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
    <Dialog open={open} onOpenChange={setOpen}>
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
                  onValueChange={setSelectedEntityId}
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
                <Select value={policyId} onValueChange={setSelectedPolicyId}>
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
              onValueChange={(value) =>
                setRunType(value === "off_cycle" ? "off_cycle" : "regular")
              }
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

          {error && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
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
