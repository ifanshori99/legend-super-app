// /operasional/checklist/template/$templateId — builder for a checklist
// template (PRD v1.7 §3 F41). "baru" renders the create form; an existing id
// loads the template and saves through update with `expectedUpdatedAt`
// (optimistic concurrency). The contract's update input cannot change `type`,
// so the type is read-only after creation; items are reordered with up/down
// buttons (mobile-safe, no drag) and the item list order is the screen order.
import * as React from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { OutletId } from "@starter/shared/core";
import type { RoleId, StationId } from "@starter/shared/access";
import type { ShiftTemplateId } from "@starter/shared/hris";
import type { FloorZone, FloorZoneId } from "@starter/shared/qr-order";
import type {
  ChecklistEvidenceKind,
  ChecklistTemplate,
  ChecklistTemplateType,
  OpsChecklistItemId,
} from "@starter/shared/operations";
import { useOnline } from "@/lib/use-online";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { evidenceLabelKey, formatDateTime, typeLabelKey } from "../logic.ts";
import { roleOptions, shiftOptions, stationOptions } from "../fixtures.ts";
import {
  useChecklistTemplate,
  useCreateChecklistTemplate,
  useFloorZones,
  useUpdateChecklistTemplate,
} from "../hooks.ts";
import { OfflineNotice } from "./offline-notice.tsx";

const NONE = "__none__";
const EVIDENCE_KINDS: readonly ChecklistEvidenceKind[] = [
  "photo",
  "number",
  "signature",
];
const TEMPLATE_TYPES: readonly ChecklistTemplateType[] = [
  "opening",
  "closing",
  "cleaning",
  "shift",
];

type ItemDraft = {
  /** Stable React/list key; not part of the contract until saved. */
  key: string;
  id?: string;
  label: string;
  instruction: string;
  requiredEvidence: ChecklistEvidenceKind[];
};

type ScheduleDraft = {
  shiftTemplateId: string | null;
  stationId: string | null;
  zoneId: string | null;
  dueTime: string;
};

function newItemDraft(key: string = newIdempotencyKey()): ItemDraft {
  return {
    key,
    label: "",
    instruction: "",
    requiredEvidence: [],
  };
}

function BuilderSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <span className="sr-only" role="status">
        {t("opsChecklist.builder.loading")}
      </span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64 w-full rounded-container" />
      <Skeleton className="h-64 w-full rounded-container" />
    </div>
  );
}

export function TemplateBuilderPage({ templateId }: { templateId: string }) {
  const t = useT();
  const online = useOnline();
  const { clock } = useOutletClock();
  const { outlet } = useTenantContext();
  const isNew = templateId === "baru";
  const templateQuery = useChecklistTemplate(isNew ? undefined : templateId);
  const floorsQuery = useFloorZones();
  const zones = floorsQuery.data?.data.zones ?? [];

  if (outlet && !isNew && templateQuery.isPending) return <BuilderSkeleton />;

  if (
    !isNew &&
    templateQuery.error instanceof ApiError &&
    templateQuery.error.status === 404
  )
    return (
      <EmptyState
        title={t("opsChecklist.builder.notFoundTitle")}
        description={t("opsChecklist.builder.notFoundHint")}
        action={
          <Button asChild variant="outline">
            <Link to="/operasional/checklist/template">
              {t("opsChecklist.builder.back")}
            </Link>
          </Button>
        }
      />
    );

  if (templateQuery.error)
    return (
      <ErrorState
        title={t("opsChecklist.builder.errorTitle")}
        description={t("opsChecklist.builder.errorHint")}
        onRetry={() => {
          void templateQuery.refetch();
        }}
      />
    );

  if (!outlet)
    return (
      <EmptyState
        title={t("state.emptyTitle")}
        description={t("state.emptyHint")}
      />
    );

  const template = isNew ? null : (templateQuery.data ?? null);
  return (
    <TemplateForm
      key={template?.id ?? "baru"}
      outletId={outlet.id}
      template={template}
      zones={zones}
      timeZone={clock.timeZone}
      online={online}
    />
  );
}

function TemplateForm({
  outletId,
  template,
  zones,
  timeZone,
  online,
}: {
  outletId: string;
  template: ChecklistTemplate | null;
  zones: readonly FloorZone[];
  timeZone: string;
  online: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const isNew = template === null;
  const createTemplate = useCreateChecklistTemplate();
  const updateTemplate = useUpdateChecklistTemplate(template?.id ?? "");
  const [name, setName] = React.useState(template?.name ?? "");
  const [type, setType] = React.useState<ChecklistTemplateType>(
    template?.type ?? "opening",
  );
  const [schedule, setSchedule] = React.useState<ScheduleDraft>({
    shiftTemplateId: template?.schedule.shiftTemplateId ?? null,
    stationId: template?.schedule.stationId ?? null,
    zoneId: template?.schedule.zoneId ?? null,
    dueTime: template?.schedule.dueTime ?? "08:00",
  });
  const [roleId, setRoleId] = React.useState<string | null>(
    template?.roleId ?? null,
  );
  const [items, setItems] = React.useState<ItemDraft[]>(() =>
    template
      ? template.items.map((item) => ({
          key: item.id,
          id: item.id,
          label: item.label,
          instruction: item.instruction ?? "",
          requiredEvidence: [...item.requiredEvidence],
        }))
      : [newItemDraft("draft-0")],
  );
  const [errors, setErrors] = React.useState<{
    name?: string;
    dueTime?: string;
    items?: string;
    itemLabels?: Record<string, string | undefined>;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  // Reorder feedback for screen readers, and where focus lands after a move
  // or removal (the pressed button may become disabled or disappear).
  const [reorderMessage, setReorderMessage] = React.useState("");
  const formRef = React.useRef<HTMLFormElement>(null);
  const pendingFocus = React.useRef<string | null>(null);

  React.useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    formRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-reorder-key="${CSS.escape(key)}"]`,
      )
      ?.focus();
  });

  const shiftOpts = shiftOptions(outletId);
  const stationOpts = stationOptions(outletId);
  const roles = roleOptions();
  const saving = createTemplate.isPending || updateTemplate.isPending;

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function toggleEvidence(
    key: string,
    kind: ChecklistEvidenceKind,
    checked: boolean,
  ) {
    setItems((current) =>
      current.map((item) => {
        if (item.key !== key) return item;
        const requiredEvidence = checked
          ? [...item.requiredEvidence.filter((entry) => entry !== kind), kind]
          : item.requiredEvidence.filter((entry) => entry !== kind);
        return { ...item, requiredEvidence };
      }),
    );
  }

  function moveItem(key: string, delta: number) {
    const index = items.findIndex((item) => item.key === key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    setItems(next);
    // Keep focus on the same arrow unless it is now disabled at an edge.
    const atEdge = delta < 0 ? target === 0 : target === next.length - 1;
    pendingFocus.current = `${key}:${
      atEdge ? (delta < 0 ? "down" : "up") : delta < 0 ? "up" : "down"
    }`;
    setReorderMessage(
      t("opsChecklist.builder.itemMoved", {
        position: target + 1,
        total: next.length,
      }),
    );
  }

  function removeItem(key: string) {
    const index = items.findIndex((item) => item.key === key);
    if (index < 0) return;
    const next = items.filter((item) => item.key !== key);
    setItems(next);
    const neighbour = next[Math.min(index, next.length - 1)];
    pendingFocus.current = neighbour ? `${neighbour.key}:remove` : "add";
    setReorderMessage(
      t("opsChecklist.builder.itemRemoved", { position: index + 1 }),
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) return;
    const nextErrors: typeof errors = {};
    if (name.trim() === "")
      nextErrors.name = t("opsChecklist.builder.nameRequired");
    if (schedule.dueTime.trim() === "")
      nextErrors.dueTime = t("opsChecklist.builder.dueTimeRequired");
    if (items.length === 0)
      nextErrors.items = t("opsChecklist.builder.itemsRequired");
    const itemLabels: Record<string, string | undefined> = {};
    for (const item of items) {
      if (item.label.trim() === "")
        itemLabels[item.key] = t("opsChecklist.builder.itemLabelRequired");
    }
    if (Object.values(itemLabels).some(Boolean))
      nextErrors.itemLabels = itemLabels;
    setErrors(nextErrors);
    setFormError(null);
    if (
      nextErrors.name !== undefined ||
      nextErrors.dueTime !== undefined ||
      nextErrors.items !== undefined ||
      nextErrors.itemLabels !== undefined
    )
      return;

    const payloadItems = items.map((item) => ({
      ...(item.id === undefined ? {} : { id: item.id as OpsChecklistItemId }),
      label: item.label.trim(),
      instruction:
        item.instruction.trim() === "" ? null : item.instruction.trim(),
      requiredEvidence: item.requiredEvidence,
    }));
    // Dialog/input state is plain text; the contract's branded ids are
    // re-applied once here, at the write boundary.
    const nextSchedule = {
      shiftTemplateId: schedule.shiftTemplateId as ShiftTemplateId | null,
      stationId: schedule.stationId as StationId | null,
      zoneId: schedule.zoneId as FloorZoneId | null,
      dueTime: schedule.dueTime,
    };

    if (isNew) {
      createTemplate.mutate(
        {
          outletId: outletId as OutletId,
          name: name.trim(),
          type,
          items: payloadItems,
          schedule: nextSchedule,
          roleId: roleId as RoleId | null,
        },
        {
          onSuccess: (created) => {
            toast({ title: t("opsChecklist.builder.saved"), tone: "success" });
            // Stay in the editor, now as the created template (shareable URL).
            void navigate({
              to: "/operasional/checklist/template/$templateId",
              params: { templateId: created.id },
              replace: true,
            });
          },
          onError: () => setFormError(t("opsChecklist.builder.saveFailed")),
        },
      );
      return;
    }

    updateTemplate.mutate(
      {
        name: name.trim(),
        items: payloadItems,
        schedule: nextSchedule,
        roleId: roleId as RoleId | null,
        expectedUpdatedAt: template.updatedAt,
      },
      {
        onSuccess: () => {
          toast({ title: t("opsChecklist.builder.saved"), tone: "success" });
        },
        onError: () => setFormError(t("opsChecklist.builder.saveFailed")),
      },
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)] gap-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/operasional/checklist/template">
            <ArrowLeft aria-hidden="true" />
            {t("opsChecklist.builder.back")}
          </Link>
        </Button>
      </div>

      <header className="grid gap-1">
        <h1 className="type-display">
          {isNew
            ? t("opsChecklist.builder.newTitle")
            : t("opsChecklist.builder.editTitle")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("opsChecklist.builder.hint")}
        </p>
        {template && (
          <p className="text-sm leading-5 text-muted-foreground tabular">
            {t("opsChecklist.builder.version", {
              version: template.version,
              time: formatDateTime(template.updatedAt, timeZone),
            })}
          </p>
        )}
      </header>

      {!online && (
        <OfflineNotice
          title={t("opsChecklist.runs.offlineTitle")}
          hint={t("opsChecklist.runs.offlineHint")}
        />
      )}

      <form ref={formRef} className="grid gap-4" onSubmit={submit} noValidate>
        <Card data-slot="checklist-template-identity">
          <h2 className="type-title">{t("opsChecklist.builder.name")}</h2>
          <FormField
            label={t("opsChecklist.builder.name")}
            required
            error={errors.name}
          >
            <Input
              value={name}
              maxLength={150}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
            />
          </FormField>

          {isNew ? (
            <FormField label={t("opsChecklist.builder.type")} required>
              <Select
                value={type}
                onValueChange={(value) =>
                  setType(value as ChecklistTemplateType)
                }
              >
                <SelectTrigger aria-label={t("opsChecklist.builder.type")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_TYPES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(typeLabelKey(entry))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : (
            <div className="grid gap-1">
              <span className="text-sm font-semibold">
                {t("opsChecklist.builder.type")}
              </span>
              <div>
                <Badge tone="neutral">{t(typeLabelKey(type))}</Badge>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("opsChecklist.builder.typeLocked")}
              </p>
            </div>
          )}

          <FormField
            label={t("opsChecklist.builder.role")}
            hint={t("opsChecklist.builder.roleHint")}
          >
            <Select
              value={roleId ?? NONE}
              onValueChange={(value) =>
                setRoleId(value === NONE ? null : value)
              }
            >
              <SelectTrigger aria-label={t("opsChecklist.builder.role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {t("opsChecklist.builder.roleNone")}
                </SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </Card>

        <Card data-slot="checklist-template-schedule">
          <h2 className="type-title">{t("opsChecklist.builder.schedule")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("opsChecklist.builder.shift")}>
              <Select
                value={schedule.shiftTemplateId ?? NONE}
                onValueChange={(value) =>
                  setSchedule((current) => ({
                    ...current,
                    shiftTemplateId: value === NONE ? null : value,
                  }))
                }
              >
                <SelectTrigger aria-label={t("opsChecklist.builder.shift")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    {t("opsChecklist.builder.shiftNone")}
                  </SelectItem>
                  {shiftOpts.map((shift) => (
                    <SelectItem key={shift.id} value={shift.id}>
                      {shift.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={t("opsChecklist.builder.station")}>
              <Select
                value={schedule.stationId ?? NONE}
                onValueChange={(value) =>
                  setSchedule((current) => ({
                    ...current,
                    stationId: value === NONE ? null : value,
                  }))
                }
              >
                <SelectTrigger aria-label={t("opsChecklist.builder.station")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    {t("opsChecklist.builder.stationNone")}
                  </SelectItem>
                  {stationOpts.map((station) => (
                    <SelectItem key={station.id} value={station.id}>
                      {station.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={t("opsChecklist.builder.zone")}>
              <Select
                value={schedule.zoneId ?? NONE}
                onValueChange={(value) =>
                  setSchedule((current) => ({
                    ...current,
                    zoneId: value === NONE ? null : value,
                  }))
                }
              >
                <SelectTrigger aria-label={t("opsChecklist.builder.zone")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    {t("opsChecklist.builder.zoneNone")}
                  </SelectItem>
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("opsChecklist.builder.dueTime")}
              required
              hint={t("opsChecklist.builder.dueTimeHint")}
              error={errors.dueTime}
            >
              <Input
                type="time"
                value={schedule.dueTime}
                onChange={(event) => {
                  setSchedule((current) => ({
                    ...current,
                    dueTime: event.target.value,
                  }));
                  setErrors((current) => ({
                    ...current,
                    dueTime: undefined,
                  }));
                }}
              />
            </FormField>
          </div>
        </Card>

        <Card data-slot="checklist-template-items">
          <div className="grid gap-1">
            <h2 className="type-title">{t("opsChecklist.builder.items")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsChecklist.builder.itemsHint")}
            </p>
          </div>

          {errors.items && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {errors.items}
            </p>
          )}

          <p className="sr-only" role="status" aria-live="polite">
            {reorderMessage}
          </p>

          <ul className="grid gap-3">
            {items.map((item, index) => (
              <li
                key={item.key}
                data-slot="checklist-item-editor"
                data-item-index={index}
                className="grid gap-3 rounded-container bg-surface-2 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold tabular">
                    {index + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-reorder-key={`${item.key}:up`}
                      aria-label={t("opsChecklist.builder.moveUp", {
                        position: index + 1,
                      })}
                      disabled={index === 0}
                      onClick={() => moveItem(item.key, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-reorder-key={`${item.key}:down`}
                      aria-label={t("opsChecklist.builder.moveDown", {
                        position: index + 1,
                      })}
                      disabled={index === items.length - 1}
                      onClick={() => moveItem(item.key, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-reorder-key={`${item.key}:remove`}
                      aria-label={t("opsChecklist.builder.removeItem", {
                        position: index + 1,
                      })}
                      onClick={() => removeItem(item.key)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <FormField
                  label={t("opsChecklist.builder.itemLabel")}
                  required
                  error={errors.itemLabels?.[item.key]}
                >
                  <Input
                    value={item.label}
                    maxLength={300}
                    onChange={(event) => {
                      updateItem(item.key, { label: event.target.value });
                      setErrors((current) => ({
                        ...current,
                        itemLabels: {
                          ...current.itemLabels,
                          [item.key]: undefined,
                        },
                      }));
                    }}
                  />
                </FormField>

                <FormField label={t("opsChecklist.builder.itemInstruction")}>
                  <Textarea
                    value={item.instruction}
                    rows={2}
                    maxLength={1000}
                    onChange={(event) =>
                      updateItem(item.key, { instruction: event.target.value })
                    }
                  />
                </FormField>

                <fieldset className="grid gap-1.5">
                  <legend className="text-sm leading-5 font-semibold">
                    {t("opsChecklist.builder.itemEvidence")}
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {EVIDENCE_KINDS.map((kind) => {
                      const id = `${item.key}-${kind}`;
                      return (
                        <div key={kind} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={item.requiredEvidence.includes(kind)}
                            onCheckedChange={(checked) =>
                              toggleEvidence(item.key, kind, checked === true)
                            }
                          />
                          <Label htmlFor={id}>
                            {t(evidenceLabelKey(kind))}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("opsChecklist.builder.evidenceHint")}
                  </p>
                </fieldset>
              </li>
            ))}
          </ul>

          <div>
            <Button
              data-reorder-key="add"
              type="button"
              variant="outline"
              onClick={() =>
                setItems((current) => [...current, newItemDraft()])
              }
            >
              <Plus aria-hidden="true" />
              {t("opsChecklist.builder.addItem")}
            </Button>
          </div>
        </Card>

        {formError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link to="/operasional/checklist/template">
              {t("common.cancel")}
            </Link>
          </Button>
          <Button type="submit" loading={saving} disabled={!online}>
            {t("opsChecklist.builder.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
