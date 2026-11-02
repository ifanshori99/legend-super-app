// One inventory item: identity, par levels, unit conversions and substitute
// ingredients ("Item Bahan & Satuan", PRD §16). `baru` opens the create form;
// type and base unit lock after creation because the update contract does not
// accept them.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Lock } from "lucide-react";
import { parseDecimal4, type Decimal4 } from "@starter/shared/core";
import type {
  InventoryItem,
  InventoryItemType,
  Uom,
} from "@starter/shared/inventory";
import type { MessageKey } from "@starter/shared/i18n";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { fieldErrors, FormField } from "@/components/ui/form-field";
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  useCreateInventoryItem,
  useInventoryItem,
  useInventoryItems,
  useUnits,
  useUpdateInventoryItem,
} from "../hooks";
import { decimalFromInput, LIST_LIMIT } from "../lib";
import { AlternatesEditor } from "./alternates-editor";
import { ConversionsEditor } from "./conversions-editor";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const TYPE_LABEL: Record<InventoryItemType, MessageKey> = {
  raw_material: "inventory.types.raw_material",
  semi_finished: "inventory.types.semi_finished",
};

type FormValues = {
  name: string;
  category: string;
  type: InventoryItemType;
  baseUomId: string;
  isPerishable: boolean;
  isActive: boolean;
  parMin: string;
  parMax: string;
};

function initialValues(
  item: InventoryItem | null,
  units: readonly Uom[],
): FormValues {
  return {
    name: item?.name ?? "",
    category: item?.category ?? "",
    type: item?.type ?? "raw_material",
    baseUomId: item?.baseUomId ?? units[0]?.id ?? "",
    isPerishable: item?.isPerishable ?? false,
    isActive: item?.isActive ?? true,
    parMin: item?.parMin ?? "",
    parMax: item?.parMax ?? "",
  };
}

function ItemForm({
  item,
  units,
  items,
}: {
  item: InventoryItem | null;
  units: readonly Uom[];
  items: readonly InventoryItem[];
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const createItem = useCreateInventoryItem();
  const updateItem = useUpdateInventoryItem();

  const [values, setValues] = React.useState<FormValues>(() =>
    initialValues(item, units),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  const update = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  const schema = React.useMemo(
    () =>
      z
        .object({
          name: z
            .string()
            .trim()
            .min(1, t("inventory.errors.required"))
            .max(150, t("inventory.errors.tooLong", { max: 150 })),
          category: z
            .string()
            .trim()
            .min(1, t("inventory.errors.required"))
            .max(50, t("inventory.errors.tooLong", { max: 50 })),
          parMin: z
            .string()
            .trim()
            .refine(
              (value) => value === "" || decimalFromInput(value) !== null,
              { message: t("inventory.editor.errors.invalidPar") },
            ),
          parMax: z
            .string()
            .trim()
            .refine(
              (value) => value === "" || decimalFromInput(value) !== null,
              { message: t("inventory.editor.errors.invalidPar") },
            ),
        })
        .refine(
          (value) => {
            const min = decimalFromInput(value.parMin);
            const max = decimalFromInput(value.parMax);
            return (
              min === null ||
              max === null ||
              parseDecimal4(max) >= parseDecimal4(min)
            );
          },
          {
            path: ["parMax"],
            message: t("inventory.editor.errors.minGreaterThanMax"),
          },
        ),
    [t],
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    setErrors({});
    setFormError(undefined);
    const parMin: Decimal4 | null = decimalFromInput(parsed.data.parMin);
    const parMax: Decimal4 | null = decimalFromInput(parsed.data.parMax);

    if (!item) {
      createItem.mutate(
        {
          name: parsed.data.name,
          category: parsed.data.category,
          type: values.type,
          baseUomId: values.baseUomId,
          isPerishable: values.isPerishable,
          parMin,
          parMax,
          idempotencyKey: newIdempotencyKey(),
        },
        {
          onSuccess: (result) => {
            toast({ title: t("inventory.editor.created"), tone: "success" });
            void navigate({
              to: "/kelola/inventori/$itemId",
              params: { itemId: result.data.id },
            });
          },
          onError: (error) =>
            setFormError(
              error instanceof ApiError
                ? error.message
                : t("inventory.errors.saveFailed"),
            ),
        },
      );
      return;
    }

    updateItem.mutate(
      {
        params: { itemId: item.id },
        body: {
          name: parsed.data.name,
          category: parsed.data.category,
          isPerishable: values.isPerishable,
          isActive: values.isActive,
          parMin,
          parMax,
          expectedUpdatedAt: item.updatedAt,
        },
      },
      {
        onSuccess: () =>
          toast({ title: t("inventory.editor.saved"), tone: "success" }),
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.code === "PRECONDITION_FAILED"
                ? t("inventory.editor.stale")
                : error.message
              : t("inventory.errors.saveFailed"),
          ),
      },
    );
  }

  const pending = createItem.isPending || updateItem.isPending;

  return (
    <div className="grid min-w-0 gap-4">
      {/* The identity fields and their save action are one form; the units and
          alternates editors below own their own forms (a nested <form> is
          invalid HTML and the browser drops it). */}
      <form onSubmit={submit} noValidate>
        <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
          <h2 className="text-base leading-6 font-semibold">
            {t("inventory.editor.sections.identity")}
          </h2>
          <FormField
            label={t("inventory.editor.fields.name")}
            hint={t("inventory.editor.hints.name")}
            error={errors.name}
            required
          >
            <Input
              value={values.name}
              onChange={(event) => update({ name: event.target.value })}
              autoComplete="off"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("inventory.editor.fields.category")}
              hint={t("inventory.editor.hints.category")}
              error={errors.category}
              required
            >
              <Input
                value={values.category}
                onChange={(event) => update({ category: event.target.value })}
                autoComplete="off"
                list="inventory-categories"
              />
            </FormField>
            <datalist id="inventory-categories">
              {[...new Set(items.map((row) => row.category))].map(
                (category) => (
                  <option key={category} value={category} />
                ),
              )}
            </datalist>
            {item ? (
              <div className="grid gap-1.5">
                <span className="text-sm font-semibold">
                  {t("inventory.editor.fields.type")}
                </span>
                <p className="flex min-h-control-sm items-center gap-2 rounded-field border border-input bg-muted px-3 text-sm">
                  <Lock
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {t(TYPE_LABEL[item.type])}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("inventory.editor.hints.locked")}
                </p>
              </div>
            ) : (
              <FormField label={t("inventory.editor.fields.type")} required>
                <Select
                  value={values.type}
                  onValueChange={(value) =>
                    update({ type: value as InventoryItemType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="raw_material">
                      {t("inventory.types.raw_material")}
                    </SelectItem>
                    <SelectItem value="semi_finished">
                      {t("inventory.types.semi_finished")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {item ? (
              <div className="grid gap-1.5">
                <span className="text-sm font-semibold">
                  {t("inventory.editor.fields.baseUom")}
                </span>
                <p className="flex min-h-control-sm items-center gap-2 rounded-field border border-input bg-muted px-3 text-sm">
                  <Lock
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {units.find((unit) => unit.id === item.baseUomId)?.code ??
                    "—"}
                </p>
              </div>
            ) : (
              <FormField
                label={t("inventory.editor.fields.baseUom")}
                hint={t("inventory.editor.hints.baseUom")}
                required
              >
                <Select
                  value={values.baseUomId}
                  onValueChange={(value) => update({ baseUomId: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.code} — {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("inventory.editor.fields.parMin")}
              hint={t("inventory.editor.hints.par")}
              error={errors.parMin}
            >
              <Input
                value={values.parMin}
                onChange={(event) => update({ parMin: event.target.value })}
                inputMode="decimal"
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("inventory.editor.fields.parMax")}
              error={errors.parMax}
            >
              <Input
                value={values.parMax}
                onChange={(event) => update({ parMax: event.target.value })}
                inputMode="decimal"
                autoComplete="off"
              />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <Label htmlFor="item-perishable">
                  {t("inventory.editor.fields.perishable")}
                </Label>
                <p className="text-sm leading-5 text-muted-foreground">
                  {values.isPerishable
                    ? t("inventory.perishable.yes")
                    : t("inventory.perishable.no")}
                </p>
              </div>
              <Switch
                id="item-perishable"
                checked={values.isPerishable}
                onCheckedChange={(checked) => update({ isPerishable: checked })}
              />
            </div>
            {item && (
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <Label htmlFor="item-active">
                    {t("inventory.editor.fields.active")}
                  </Label>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("inventory.editor.hints.active")}
                  </p>
                </div>
                <Switch
                  id="item-active"
                  checked={values.isActive}
                  onCheckedChange={(checked) => update({ isActive: checked })}
                />
              </div>
            )}
          </div>
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              {formError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={pending}>
              {t("inventory.editor.save")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/kelola/inventori">
                <ArrowLeft aria-hidden="true" />
                {t("inventory.editor.back")}
              </Link>
            </Button>
          </div>
        </section>
      </form>

      {item && (
        <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
          <h2 className="text-base leading-6 font-semibold">
            {t("inventory.editor.sections.units")}
          </h2>
          <ConversionsEditor
            itemId={item.id}
            itemName={item.name}
            units={units}
          />
        </section>
      )}

      {item && (
        <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
          <div className="grid gap-1">
            <h2 className="text-base leading-6 font-semibold">
              {t("inventory.editor.sections.alternates")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventory.editor.alternates.hint")}
            </p>
          </div>
          <AlternatesEditor itemId={item.id} items={items} />
        </section>
      )}
    </div>
  );
}

export function ItemEditorPage({ itemId }: { itemId: string }) {
  const t = useT();
  const isNew = itemId === "baru";
  const itemQuery = useInventoryItem(isNew ? undefined : itemId);
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });

  const loading =
    unitsQuery.isPending ||
    itemsQuery.isPending ||
    (!isNew && itemQuery.isPending);
  const failed =
    unitsQuery.isError || itemsQuery.isError || (!isNew && itemQuery.isError);
  const item = itemQuery.data?.data ?? null;

  function retry() {
    void unitsQuery.refetch();
    void itemsQuery.refetch();
    if (!isNew) void itemQuery.refetch();
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-1">
        <h2 className="type-title">
          {isNew
            ? t("inventory.editor.createTitle")
            : t("inventory.editor.editTitle")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {isNew
            ? t("inventory.editor.createSubtitle")
            : t("inventory.editor.editSubtitle")}
        </p>
      </div>
      {loading ? (
        <div className="grid gap-3 rounded-container border bg-card p-card shadow-hairline">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      ) : failed || (!isNew && !item) ? (
        <div className="rounded-container border bg-card">
          <ErrorState onRetry={retry} />
        </div>
      ) : (
        <ItemForm
          key={item?.id ?? "new"}
          item={item}
          units={unitsQuery.data?.data ?? []}
          items={itemsQuery.data?.data ?? []}
        />
      )}
    </div>
  );
}
