// "Area & Unit" tab: the generic facility hierarchy — facility → area → unit
// (PRD v1.7 §3 F25 "Model Generik"). Units are the booths guests book; the
// contract has create/read for units and maintenance actions elsewhere, so this
// screen creates them and shows their status (no delete endpoint exists).
import * as React from "react";
import type { FacilityArea, FacilityConfig } from "@starter/shared/facility";
import {
  createFacilityAreaSchema,
  createFacilityUnitSchema,
  updateFacilityAreaSchema,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useCreateArea, useCreateUnit, useUpdateArea } from "../hooks.ts";
import {
  parseCreateDraft,
  parseInteger,
  parseUpdateDraft,
  unitStatusLabel,
  unitStatusTone,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

type AreaDialogState =
  { mode: "create" } | { mode: "edit"; area: FacilityArea } | null;

type UnitDialogState = { areaId: string; areaName: string } | null;

export function AreasTab({
  facilityId,
  config,
}: {
  facilityId: string;
  config: FacilityConfig;
}) {
  const t = useT();
  const [areaDialog, setAreaDialog] = React.useState<AreaDialogState>(null);
  const [unitDialog, setUnitDialog] = React.useState<UnitDialogState>(null);

  const areas = [...config.areas]
    .filter((area) => area.facilityId === facilityId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const unitsByArea: ReadonlyMap<string, (typeof config.units)[number][]> =
    new Map(
      areas.map((area) => [
        area.id,
        config.units
          .filter((unit) => unit.areaId === area.id)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      ]),
    );
  const nextAreaSortOrder = areas.length;
  const nextUnitSortOrder = (areaId: string) =>
    unitsByArea.get(areaId)?.length ?? 0;

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-areas"
        title={t("facilityAdmin.areas.title")}
        description={t("facilityAdmin.areas.description")}
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => setAreaDialog({ mode: "create" })}
          >
            {t("facilityAdmin.areas.addArea")}
          </Button>
        }
      >
        {areas.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.areas.emptyAreas")}
            description={t("facilityAdmin.areas.emptyAreasHint")}
          />
        ) : (
          <div className="grid gap-3">
            {areas.map((area) => {
              const units = unitsByArea.get(area.id) ?? [];
              return (
                <div
                  key={area.id}
                  data-slot="facility-area"
                  data-area-id={area.id}
                  className="grid gap-3 rounded-container border-(length:--border-w) border-border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid gap-0.5">
                      <p className="font-semibold">{area.name}</p>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("facilityAdmin.areas.unitCount", {
                          count: units.length,
                        })}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setUnitDialog({
                            areaId: area.id,
                            areaName: area.name,
                          })
                        }
                      >
                        {t("facilityAdmin.areas.addUnit")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("facilityAdmin.areas.editArea")}
                        onClick={() => setAreaDialog({ mode: "edit", area })}
                      >
                        {t("facilityAdmin.common.edit")}
                      </Button>
                    </div>
                  </div>
                  {units.length === 0 ? (
                    <div className="grid gap-1 rounded-container bg-surface-2 p-4">
                      <p className="text-sm font-semibold">
                        {t("facilityAdmin.areas.noUnits")}
                      </p>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("facilityAdmin.areas.noUnitsHint")}
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t("facilityAdmin.areas.unitCode")}
                          </TableHead>
                          <TableHead>
                            {t("facilityAdmin.areas.unitStatusLabel")}
                          </TableHead>
                          <TableHead numeric>
                            {t("facilityAdmin.areas.unitSortOrder")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {units.map((unit) => (
                          <TableRow
                            key={unit.id}
                            data-slot="facility-unit"
                            data-unit-id={unit.id}
                          >
                            <TableCell className="font-semibold">
                              {unit.code}
                            </TableCell>
                            <TableCell>
                              <Badge tone={unitStatusTone[unit.status]}>
                                {t(unitStatusLabel[unit.status])}
                              </Badge>
                            </TableCell>
                            <TableCell numeric>{unit.sortOrder}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facilityAdmin.areas.deleteUnavailableHint")}
        </p>
      </ConfigSection>

      {areaDialog && (
        <AreaDialog
          key={areaDialog.mode === "edit" ? areaDialog.area.id : "new-area"}
          open
          onOpenChange={(open) => !open && setAreaDialog(null)}
          facilityId={facilityId}
          area={areaDialog.mode === "edit" ? areaDialog.area : null}
          nextSortOrder={nextAreaSortOrder}
        />
      )}

      {unitDialog && (
        <UnitDialog
          key={`${unitDialog.areaId}-new-unit`}
          open
          onOpenChange={(open) => !open && setUnitDialog(null)}
          facilityId={facilityId}
          areaId={unitDialog.areaId}
          areaName={unitDialog.areaName}
          nextSortOrder={nextUnitSortOrder(unitDialog.areaId)}
          existingCodes={config.units
            .filter((unit) => unit.facilityId === facilityId)
            .map((unit) => unit.code.toLocaleLowerCase("id-ID"))}
        />
      )}
    </div>
  );
}

function AreaDialog({
  open,
  onOpenChange,
  facilityId,
  area,
  nextSortOrder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  area: FacilityArea | null;
  nextSortOrder: number;
}) {
  const t = useT();
  const toast = useToast();
  const createArea = useCreateArea(facilityId);
  const updateArea = useUpdateArea(facilityId);
  const [name, setName] = React.useState(area?.name ?? "");
  const [sortOrder, setSortOrder] = React.useState(
    String(area?.sortOrder ?? nextSortOrder),
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();
  const pending = createArea.isPending || updateArea.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = name.trim();
    if (trimmed.length === 0)
      next.name = t("facilityAdmin.areas.errorsNameRequired");
    else if (trimmed.length > 150)
      next.name = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.areas.areaName"),
        max: 150,
      });
    const parsedSort = sortOrder.trim() === "" ? undefined : sortOrder;
    const sort =
      parsedSort === undefined ? undefined : parseInteger(parsedSort);
    if (
      parsedSort !== undefined &&
      (sort === null || (sort !== undefined && sort > 10_000))
    )
      next.sortOrder = t("facilityAdmin.areas.errorsSortOrder");

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);

    if (area) {
      const parsed = parseUpdateDraft(updateFacilityAreaSchema, {
        name: trimmed,
        sortOrder: sort,
      });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        setFormError(
          t("form.errorSummary", { count: parsed.error.issues.length }),
        );
        return;
      }
      updateArea.mutate(
        {
          areaId: area.id,
          body: parsed.data,
          expectedUpdatedAt: area.updatedAt,
        },
        {
          onSuccess: () => {
            toast({
              title: t("facilityAdmin.areas.areaUpdated"),
              tone: "success",
            });
            onOpenChange(false);
          },
          onError: (error) =>
            setFormError(
              error instanceof ApiError
                ? error.message
                : t("facilityAdmin.areas.areaUpdateFailed"),
            ),
        },
      );
      return;
    }

    const parsed = parseCreateDraft(createFacilityAreaSchema, {
      facilityId,
      name: trimmed,
      sortOrder: sort,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    createArea.mutate(parsed.data, {
      onSuccess: () => {
        toast({ title: t("facilityAdmin.areas.areaCreated"), tone: "success" });
        onOpenChange(false);
      },
      onError: (error) =>
        setFormError(
          error instanceof ApiError
            ? error.message
            : t("facilityAdmin.areas.areaCreateFailed"),
        ),
    });
  }

  return (
    <PendingDialog pending={pending} open={open} onOpenChange={onOpenChange}>
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {area
              ? t("facilityAdmin.areas.editAreaTitle")
              : t("facilityAdmin.areas.createAreaTitle")}
          </DialogTitle>
          <DialogDescription>
            {area
              ? t("facilityAdmin.areas.editAreaHint")
              : t("facilityAdmin.areas.createAreaHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField
            label={t("facilityAdmin.areas.areaName")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("facilityAdmin.areas.areaSortOrder")}
            error={errors.sortOrder}
            hint={t("facilityAdmin.areas.areaSortOrderHint")}
          >
            <Input
              inputMode="numeric"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </FormField>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              {t("facilityAdmin.areas.saveArea")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}

function UnitDialog({
  open,
  onOpenChange,
  facilityId,
  areaId,
  areaName,
  nextSortOrder,
  existingCodes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  areaId: string;
  areaName: string;
  nextSortOrder: number;
  existingCodes: readonly string[];
}) {
  const t = useT();
  const toast = useToast();
  const createUnit = useCreateUnit(facilityId);
  const [code, setCode] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState(String(nextSortOrder));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = code.trim();
    if (trimmed.length === 0)
      next.code = t("facilityAdmin.areas.errorsCodeRequired");
    else if (trimmed.length > 20)
      next.code = t("facilityAdmin.areas.errorsCodeTooLong");
    else if (existingCodes.includes(trimmed.toLocaleLowerCase("id-ID")))
      next.code = t("facilityAdmin.areas.errorsCodeTaken");
    const sort = sortOrder.trim() === "" ? undefined : parseInteger(sortOrder);
    if (
      sortOrder.trim() !== "" &&
      (sort === null || (sort !== undefined && sort > 10_000))
    )
      next.sortOrder = t("facilityAdmin.areas.errorsSortOrder");

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);

    const parsed = parseCreateDraft(createFacilityUnitSchema, {
      facilityId,
      areaId,
      code: trimmed,
      sortOrder: sort,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    createUnit.mutate(parsed.data, {
      onSuccess: () => {
        toast({ title: t("facilityAdmin.areas.unitCreated"), tone: "success" });
        onOpenChange(false);
      },
      onError: (error) =>
        setFormError(
          error instanceof ApiError
            ? error.message
            : t("facilityAdmin.areas.unitCreateFailed"),
        ),
    });
  }

  return (
    <PendingDialog
      pending={createUnit.isPending}
      open={open}
      onOpenChange={onOpenChange}
    >
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("facilityAdmin.areas.createUnitTitleArea", {
              area: areaName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("facilityAdmin.areas.createUnitHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField
            label={t("facilityAdmin.areas.unitCode")}
            hint={t("facilityAdmin.areas.unitCodeHint")}
            error={errors.code}
            required
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("facilityAdmin.areas.unitSortOrder")}
            error={errors.sortOrder}
          >
            <Input
              inputMode="numeric"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </FormField>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={createUnit.isPending}>
              {t("facilityAdmin.areas.saveUnit")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
