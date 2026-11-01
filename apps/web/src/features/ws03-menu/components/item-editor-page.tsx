// One menu item: content, photo, labels/allergens, station and course
// (PRD §8 "Struktur Menu", "Routing Stasiun", "Konten Menu"), plus the
// variant and modifier sections. Saves through the typed endpoints.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { ApiError } from "@/lib/api/errors";
import type { MenuItemAdmin } from "@starter/shared/menu";
import {
  useCategories,
  useCreateItem,
  useItem,
  useStations,
  useUpdateItem,
} from "../hooks";
import { ImageField, type MenuImageValue } from "./image-field";
import { ModifierSection } from "./modifier-section";
import { VariantSection } from "./variant-section";

const LABEL_KEYS = {
  baru: "menu.editor.labels.new",
  terlaris: "menu.editor.labels.bestseller",
  pedas: "menu.editor.labels.spicy",
  vegetarian: "menu.editor.labels.vegetarian",
} as const;

const ALLERGEN_KEYS = {
  susu: "menu.editor.allergens.milk",
  kacang: "menu.editor.allergens.nuts",
  gluten: "menu.editor.allergens.gluten",
  telur: "menu.editor.allergens.egg",
  kedelai: "menu.editor.allergens.soy",
  seafood: "menu.editor.allergens.seafood",
} as const;

const COURSES = ["drink", "appetizer", "main", "dessert"] as const;

const NONE = "none";

type FormValues = {
  name: string;
  categoryId: string;
  description: string;
  type: "single" | "combo";
  stationId: string;
  course: string;
  labels: string[];
  allergens: string[];
  isActive: boolean;
  image: MenuImageValue | null;
};

function initialValues(item: MenuItemAdmin | null): FormValues {
  return {
    name: item?.name ?? "",
    categoryId: item?.categoryId ?? "",
    description: item?.description ?? "",
    type: item?.type ?? "single",
    stationId: item?.stationId ?? NONE,
    course: item?.course ?? NONE,
    labels: item?.labels ?? [],
    allergens: item?.allergens ?? [],
    isActive: item?.isActive ?? true,
    image:
      item?.mediaId && item.mediaUrl
        ? { mediaId: item.mediaId, mediaUrl: item.mediaUrl }
        : null,
  };
}

export function ItemEditorPage({ itemId }: { itemId: string }) {
  const t = useT();
  const isNew = itemId === "baru";
  const itemQuery = useItem(isNew ? undefined : itemId);
  const categoriesQuery = useCategories({ limit: 100 });
  const stationsQuery = useStations({ limit: 100 });

  // The detail query stays disabled while creating ("baru"), so its pending
  // flag must not hold the form on the skeleton.
  const itemPending = !isNew && itemQuery.isPending;
  if (itemPending || categoriesQuery.isPending || stationsQuery.isPending)
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64" />
      </div>
    );

  if (itemQuery.error instanceof ApiError && itemQuery.error.status === 404)
    return (
      <EmptyState
        title={t("menu.editor.notFoundTitle")}
        description={t("menu.editor.notFoundHint")}
        action={
          <Button asChild variant="outline">
            <Link to="/kelola/menu">{t("menu.list.title")}</Link>
          </Button>
        }
      />
    );

  if (itemQuery.isError || categoriesQuery.isError || stationsQuery.isError)
    return (
      <ErrorState
        onRetry={() => {
          void itemQuery.refetch();
          void categoriesQuery.refetch();
          void stationsQuery.refetch();
        }}
      />
    );

  if (!isNew && !itemQuery.data)
    return (
      <EmptyState
        title={t("menu.list.emptyTitle")}
        description={t("menu.list.emptyHint")}
        action={
          <Button asChild variant="outline">
            <Link to="/kelola/menu">{t("menu.list.title")}</Link>
          </Button>
        }
      />
    );

  return (
    <ItemEditor
      itemId={isNew ? null : itemId}
      item={isNew ? null : (itemQuery.data?.data ?? null)}
      categories={categoriesQuery.data?.data ?? []}
      stations={stationsQuery.data?.data ?? []}
    />
  );
}

function ItemEditor({
  itemId,
  item,
  categories,
  stations,
}: {
  itemId: string | null;
  item: MenuItemAdmin | null;
  categories: { id: string; name: string }[];
  stations: { id: string; name: string }[];
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();

  const [tab, setTab] = React.useState("content");
  const [values, setValues] = React.useState<FormValues>(() =>
    initialValues(item),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  const schema = React.useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t("menu.errors.required"))
          .max(150, t("menu.errors.tooLong", { max: 150 })),
        categoryId: z.string().min(1, t("menu.errors.required")),
        description: z
          .string()
          .max(1000, t("menu.errors.tooLong", { max: 1000 })),
      }),
    [t],
  );

  const update = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((entry) => entry !== value)
      : [...list, value];
  }

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
    const body = {
      name: parsed.data.name,
      categoryId: parsed.data.categoryId,
      description: parsed.data.description,
      type: values.type,
      stationId: values.stationId === NONE ? null : values.stationId,
      course: values.course === NONE ? null : values.course,
      labels: values.labels,
      allergens: values.allergens,
      mediaId: values.image?.mediaId ?? null,
      isActive: values.isActive,
    };
    if (!itemId) {
      createItem.mutate(body, {
        onSuccess: (result) => {
          toast({ title: t("menu.editor.createdToast"), tone: "success" });
          void navigate({
            to: "/kelola/menu/$itemId",
            params: { itemId: result.data.id },
          });
        },
        onError: () => setFormError(t("menu.errors.saveFailed")),
      });
      return;
    }
    updateItem.mutate(
      { itemId, body },
      {
        onSuccess: () => {
          toast({ title: t("menu.editor.updatedToast"), tone: "success" });
        },
        onError: () => setFormError(t("menu.errors.saveFailed")),
      },
    );
  }

  const labelOptions = Array.from(
    new Set([...Object.keys(LABEL_KEYS), ...values.labels]),
  );
  const allergenOptions = Array.from(
    new Set([...Object.keys(ALLERGEN_KEYS), ...values.allergens]),
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/kelola/menu" aria-label={t("menu.list.title")}>
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-xl leading-7 font-semibold">
            {item ? item.name : t("menu.editor.createTitle")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {item
              ? (categories.find((category) => category.id === item.categoryId)
                  ?.name ?? t("menu.list.noCategory"))
              : t("menu.editor.createHint")}
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="content">
            {t("menu.editor.sections.content")}
          </TabsTrigger>
          <TabsTrigger value="variants">
            {t("menu.editor.sections.variants")}
          </TabsTrigger>
          <TabsTrigger value="modifiers">
            {t("menu.editor.sections.modifiers")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content">
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="grid gap-4 rounded-xl border bg-card p-card">
                <FormField
                  label={t("menu.editor.fields.name")}
                  hint={t("menu.editor.fields.nameHint")}
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
                    label={t("menu.editor.fields.category")}
                    error={errors.categoryId}
                    required
                  >
                    <Select
                      value={values.categoryId}
                      onValueChange={(value) => update({ categoryId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("menu.list.filters.category")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label={t("menu.editor.fields.type")} required>
                    <Select
                      value={values.type}
                      onValueChange={(value) =>
                        update({ type: value as FormValues["type"] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single">
                          {t("menu.editor.type.single")}
                        </SelectItem>
                        <SelectItem value="combo">
                          {t("menu.editor.type.combo")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                </div>

                <FormField
                  label={t("menu.editor.fields.description")}
                  hint={t("menu.editor.fields.descriptionHint")}
                  error={errors.description}
                >
                  <Textarea
                    value={values.description}
                    onChange={(event) =>
                      update({ description: event.target.value })
                    }
                    rows={3}
                  />
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label={t("menu.editor.fields.station")}>
                    <Select
                      value={values.stationId}
                      onValueChange={(value) => update({ stationId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>
                          {t("menu.list.noStation")}
                        </SelectItem>
                        {stations.map((station) => (
                          <SelectItem key={station.id} value={station.id}>
                            {station.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField
                    label={t("menu.editor.fields.course")}
                    hint={t("menu.editor.courseHint")}
                  >
                    <Select
                      value={values.course}
                      onValueChange={(value) => update({ course: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>
                          {t("menu.editor.course.none")}
                        </SelectItem>
                        {COURSES.map((course) => (
                          <SelectItem key={course} value={course}>
                            {t(`menu.editor.course.${course}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                </div>

                <fieldset className="grid gap-2">
                  <legend className="text-sm font-semibold">
                    {t("menu.editor.fields.labels")}
                  </legend>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("menu.editor.labelHint")}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {labelOptions.map((label) => {
                      const id = `item-label-${label}`;
                      return (
                        <div key={label} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={values.labels.includes(label)}
                            onCheckedChange={() =>
                              update({ labels: toggle(values.labels, label) })
                            }
                          />
                          <Label htmlFor={id} className="font-normal">
                            {label in LABEL_KEYS
                              ? t(LABEL_KEYS[label as keyof typeof LABEL_KEYS])
                              : label}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>

                <fieldset className="grid gap-2">
                  <legend className="text-sm font-semibold">
                    {t("menu.editor.fields.allergens")}
                  </legend>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("menu.editor.allergenHint")}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {allergenOptions.map((allergen) => {
                      const id = `item-allergen-${allergen}`;
                      return (
                        <div key={allergen} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={values.allergens.includes(allergen)}
                            onCheckedChange={() =>
                              update({
                                allergens: toggle(values.allergens, allergen),
                              })
                            }
                          />
                          <Label htmlFor={id} className="font-normal">
                            {allergen in ALLERGEN_KEYS
                              ? t(
                                  ALLERGEN_KEYS[
                                    allergen as keyof typeof ALLERGEN_KEYS
                                  ],
                                )
                              : allergen}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              </div>

              <div className="grid gap-4 self-start rounded-xl border bg-card p-card">
                <div className="grid gap-1.5">
                  <Label>{t("menu.editor.fields.photo")}</Label>
                  <ImageField
                    value={values.image}
                    onChange={(image) => update({ image })}
                  />
                </div>
                <div className="flex items-start justify-between gap-3 border-t pt-4">
                  <div className="min-w-0">
                    <Label htmlFor="item-active">
                      {t("menu.editor.fields.active")}
                    </Label>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {t("menu.editor.activeHint")}
                    </p>
                  </div>
                  <Switch
                    id="item-active"
                    checked={values.isActive}
                    onCheckedChange={(checked) => update({ isActive: checked })}
                  />
                </div>
              </div>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
              >
                {formError}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button asChild type="button" variant="outline">
                <Link to="/kelola/menu">{t("common.cancel")}</Link>
              </Button>
              <Button
                type="submit"
                loading={createItem.isPending || updateItem.isPending}
              >
                {t("menu.editor.save")}
              </Button>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="variants">
          {itemId ? (
            <VariantSection itemId={itemId} />
          ) : (
            <p className="rounded-xl border bg-card p-card text-sm text-muted-foreground">
              {t("menu.editor.savedFirst")}
            </p>
          )}
        </TabsContent>

        <TabsContent value="modifiers">
          {itemId ? (
            <ModifierSection itemId={itemId} />
          ) : (
            <p className="rounded-xl border bg-card p-card text-sm text-muted-foreground">
              {t("menu.editor.savedFirst")}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
