// One menu item: content, photo, labels/allergens, station and course
// (PRD §8 "Struktur Menu", "Routing Stasiun", "Konten Menu"), plus the
// variant and modifier sections. Saves through the typed endpoints.
import * as React from "react";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { fieldErrors, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
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
import { focusFirstInvalid } from "@/lib/focus-first-invalid";
import {
  menuItemPhotoMissing,
  updateItemInputSchema,
  type MenuItemAdmin,
} from "@starter/shared/menu";
import {
  useCategories,
  useCreateItem,
  useItem,
  useStations,
  useUpdateItem,
} from "../hooks";
import { useMenuWrites } from "../access";
import { ImageField, type MenuImageValue } from "./image-field";
import { ModifierSection } from "./modifier-section";
import {
  NO_STATION,
  StationRoutingSection,
  STATION_TYPES,
  type StationTypeValue,
} from "./station-routing-section";
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
  /** Brand-level station type; "" until one is chosen. */
  stationType: string;
  /** Outlet-only override station, or NO_STATION. */
  stationId: string;
  course: string;
  labels: string[];
  allergens: string[];
  isActive: boolean;
  isBreakfast: boolean;
  image: MenuImageValue | null;
};

type ItemPatch = z.input<typeof updateItemInputSchema>;

function initialValues(item: MenuItemAdmin | null): FormValues {
  return {
    name: item?.name ?? "",
    categoryId: item?.categoryId ?? "",
    description: item?.description ?? "",
    type: item?.type ?? "single",
    stationType: item?.stationType ?? "",
    stationId: item?.stationId ?? NO_STATION,
    course: item?.course ?? NONE,
    labels: item?.labels ?? [],
    allergens: item?.allergens ?? [],
    // Q23: a new item starts as a draft; it needs its photo before it can be
    // shown in the menu (the API refuses an active item without a photo).
    isActive: item?.isActive ?? false,
    isBreakfast: item?.isBreakfast ?? false,
    image:
      item?.mediaId && item.mediaUrl
        ? { mediaId: item.mediaId, mediaUrl: item.mediaUrl }
        : null,
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

/**
 * Only the fields the manager changed. The API refuses a write that would
 * publish an item without a photo (Q23), and re-sending an unchanged
 * `isActive: true` for an existing item is a publish: a legacy item without a
 * photo must stay editable for everything else.
 */
function itemPatch(values: FormValues, item: MenuItemAdmin): ItemPatch {
  const initial = initialValues(item);
  const patch: ItemPatch = {};
  if (values.name.trim() !== initial.name) patch.name = values.name.trim();
  if (values.categoryId !== initial.categoryId)
    patch.categoryId = values.categoryId;
  if (values.description !== initial.description)
    patch.description = values.description;
  if (values.type !== initial.type) patch.type = values.type;
  if (values.stationType !== initial.stationType && values.stationType)
    patch.stationType = values.stationType as StationTypeValue;
  if (values.stationId !== initial.stationId)
    patch.stationId = values.stationId === NO_STATION ? null : values.stationId;
  if (values.course !== initial.course)
    patch.course = values.course === NONE ? null : values.course;
  if (!sameList(values.labels, initial.labels)) patch.labels = values.labels;
  if (!sameList(values.allergens, initial.allergens))
    patch.allergens = values.allergens;
  if ((values.image?.mediaId ?? null) !== (initial.image?.mediaId ?? null))
    patch.mediaId = values.image?.mediaId ?? null;
  if (values.isActive !== initial.isActive) patch.isActive = values.isActive;
  if (values.isBreakfast !== initial.isBreakfast)
    patch.isBreakfast = values.isBreakfast;
  return patch;
}

export function ItemEditorPage({ itemId }: { itemId: string }) {
  const t = useT();
  const { canManageItems } = useMenuWrites();
  const isNew = itemId === "baru";
  const itemQuery = useItem(isNew ? undefined : itemId);
  const categoriesQuery = useCategories({ limit: 100 });
  const stationsQuery = useStations({ limit: 100 });

  // `baru` is a create form; a view-only visitor opening it directly goes back
  // to the list instead of seeing write controls that the API would refuse.
  if (isNew && !canManageItems) return <Navigate to="/kelola/menu" replace />;

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

  if (itemQuery.isError || categoriesQuery.isError)
    return (
      <ErrorState
        onRetry={() => {
          void itemQuery.refetch();
          void categoriesQuery.refetch();
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
      stationsFailed={stationsQuery.isError}
      onRetryStations={() => void stationsQuery.refetch()}
    />
  );
}

function ItemEditor({
  itemId,
  item,
  categories,
  stations,
  stationsFailed,
  onRetryStations,
}: {
  itemId: string | null;
  item: MenuItemAdmin | null;
  categories: { id: string; name: string }[];
  stations: { id: string; name: string }[];
  stationsFailed: boolean;
  onRetryStations: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { canManageItems } = useMenuWrites();
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();

  const [tab, setTab] = React.useState("content");
  const [values, setValues] = React.useState<FormValues>(() =>
    initialValues(item),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  // A legacy item without a type stays savable; the type becomes required for
  // a new item or once the manager touches the field.
  const [typeTouched, setTypeTouched] = React.useState(false);
  const [formError, setFormError] = React.useState<string | undefined>();
  const formRef = React.useRef<HTMLFormElement>(null);

  const requireType = itemId === null || typeTouched;
  const schema = React.useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t("menu.errors.required"))
          .max(150, t("menu.errors.tooLong", { max: 150 })),
        categoryId: z.string().min(1, t("menu.errors.required")),
        stationType: z
          .string()
          .refine(
            (value) =>
              !requireType ||
              (STATION_TYPES as readonly string[]).includes(value),
            t("menu.editor.station.typeRequired"),
          ),
        description: z
          .string()
          .max(1000, t("menu.errors.tooLong", { max: 1000 })),
      }),
    [t, requireType],
  );

  const update = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((entry) => entry !== value)
      : [...list, value];
  }

  /** Q23: the item would be published without its mandatory photo. */
  const photoRequired = menuItemPhotoMissing({
    isActive: values.isActive,
    mediaId: values.image?.mediaId ?? null,
  });
  const patch = item ? itemPatch(values, item) : null;
  const unchanged = patch !== null && Object.keys(patch).length === 0;
  /**
   * Q23: mirror of the API refusal — only a write that publishes (activation,
   * or clearing the photo of an active item) is blocked. A legacy active item
   * without a photo stays editable for everything else.
   */
  const publishBlocked = (() => {
    if (!item || !patch) return photoRequired;
    if (patch.isActive !== true && patch.mediaId !== null) return false;
    return menuItemPhotoMissing({
      isActive: patch.isActive ?? item.isActive,
      mediaId: patch.mediaId !== undefined ? patch.mediaId : item.mediaId,
    });
  })();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      focusFirstInvalid(formRef.current);
      return;
    }
    setErrors({});
    setFormError(undefined);
    // Q23: the photo is mandatory before an item can be shown in the menu, so
    // this publish is blocked here instead of bouncing off the API.
    if (publishBlocked) {
      setTab("content");
      setFormError(t("menu.editor.photoRequiredHint"));
      return;
    }
    const body = {
      name: parsed.data.name,
      categoryId: parsed.data.categoryId,
      description: parsed.data.description,
      type: values.type,
      stationType: (values.stationType || null) as StationTypeValue | null,
      stationId: values.stationId === NO_STATION ? null : values.stationId,
      course: values.course === NONE ? null : values.course,
      labels: values.labels,
      allergens: values.allergens,
      mediaId: values.image?.mediaId ?? null,
      isActive: values.isActive,
      isBreakfast: values.isBreakfast,
    };
    const onError = (error: unknown) =>
      setFormError(
        error instanceof ApiError && error.code === "MENU_PHOTO_REQUIRED"
          ? t("menu.editor.photoRequiredHint")
          : t("menu.errors.saveFailed"),
      );
    if (!itemId) {
      createItem.mutate(body, {
        onSuccess: (result) => {
          toast({ title: t("menu.editor.createdToast"), tone: "success" });
          void navigate({
            to: "/kelola/menu/$itemId",
            params: { itemId: result.data.id },
          });
        },
        onError,
      });
      return;
    }
    // Nothing changed: skip the request instead of sending an empty PATCH.
    if (unchanged) {
      toast({ title: t("menu.editor.noChangesToast"), tone: "info" });
      return;
    }
    updateItem.mutate(
      { itemId, body: patch ?? body },
      {
        onSuccess: () => {
          toast({ title: t("menu.editor.updatedToast"), tone: "success" });
        },
        onError,
      },
    );
  }

  const labelOptions = Array.from(
    new Set([...Object.keys(LABEL_KEYS), ...values.labels]),
  );
  const allergenOptions = Array.from(
    new Set([...Object.keys(ALLERGEN_KEYS), ...values.allergens]),
  );

  // A view-only visitor gets the same detail without any write control; the
  // variant and modifier sections gate their own buttons the same way.
  if (!canManageItems && item)
    return (
      <ReadOnlyItemDetail
        item={item}
        categories={categories}
        stations={stations}
      />
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/kelola/menu" aria-label={t("menu.list.title")}>
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h2 className="truncate type-title">
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
          <TabsTrigger value="content" className="max-md:min-h-11">
            {t("menu.editor.sections.content")}
          </TabsTrigger>
          <TabsTrigger value="variants" className="max-md:min-h-11">
            {t("menu.editor.sections.variants")}
          </TabsTrigger>
          <TabsTrigger value="modifiers" className="max-md:min-h-11">
            {t("menu.editor.sections.modifiers")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content">
          <form ref={formRef} onSubmit={submit} className="grid gap-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="grid content-start gap-4">
                <CardShell>
                  <Card className="gap-4">
                    <FormField
                      label={t("menu.editor.fields.name")}
                      hint={t("menu.editor.fields.nameHint")}
                      error={errors.name}
                      required
                    >
                      <Input
                        value={values.name}
                        onChange={(event) =>
                          update({ name: event.target.value })
                        }
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
                          onValueChange={(value) =>
                            update({ categoryId: value })
                          }
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
                            <div
                              key={label}
                              className="flex items-center gap-2"
                            >
                              <Checkbox
                                id={id}
                                checked={values.labels.includes(label)}
                                onCheckedChange={() =>
                                  update({
                                    labels: toggle(values.labels, label),
                                  })
                                }
                              />
                              <Label htmlFor={id} className="font-normal">
                                {label in LABEL_KEYS
                                  ? t(
                                      LABEL_KEYS[
                                        label as keyof typeof LABEL_KEYS
                                      ],
                                    )
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
                            <div
                              key={allergen}
                              className="flex items-center gap-2"
                            >
                              <Checkbox
                                id={id}
                                checked={values.allergens.includes(allergen)}
                                onCheckedChange={() =>
                                  update({
                                    allergens: toggle(
                                      values.allergens,
                                      allergen,
                                    ),
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
                  </Card>
                </CardShell>

                <StationRoutingSection
                  stationType={values.stationType}
                  stationId={values.stationId}
                  typeError={errors.stationType}
                  loadFailed={stationsFailed}
                  onRetry={onRetryStations}
                  onChange={(change) => {
                    if (change.stationType !== undefined) setTypeTouched(true);
                    update(change);
                  }}
                />
              </div>

              <CardShell className="self-start">
                <Card className="gap-4">
                  <div className="grid gap-1.5">
                    <Label>{t("menu.editor.fields.photo")}</Label>
                    <ImageField
                      value={values.image}
                      onChange={(image) => update({ image })}
                      // Q23: "Tampil di menu" needs the photo, so the reason is
                      // stated where the manager can fix it. A legacy active
                      // row keeps the note as a warning: it is readable and
                      // editable, but it cannot be published again until it
                      // has a photo.
                      requiredNote={
                        photoRequired
                          ? {
                              text: `${t("menu.editor.photoRequired")}. ${t("menu.editor.photoRequiredHint")}`,
                              blocking: publishBlocked,
                            }
                          : undefined
                      }
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
                      onCheckedChange={(checked) =>
                        update({ isActive: checked })
                      }
                    />
                  </div>
                  <div className="flex items-start justify-between gap-3 border-t pt-4">
                    <div className="min-w-0">
                      <Label htmlFor="item-breakfast">
                        {t("menu.editor.fields.breakfast")}
                      </Label>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t("menu.editor.breakfastHint")}
                      </p>
                    </div>
                    <Switch
                      id="item-breakfast"
                      checked={values.isBreakfast}
                      onCheckedChange={(checked) =>
                        update({ isBreakfast: checked })
                      }
                    />
                  </div>
                </Card>
              </CardShell>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-control border-(length:--border-w) border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
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
            <p className="rounded-container border-(length:--border-w) bg-card p-card text-sm text-muted-foreground shadow-hairline">
              {t("menu.editor.savedFirst")}
            </p>
          )}
        </TabsContent>

        <TabsContent value="modifiers">
          {itemId ? (
            <ModifierSection itemId={itemId} />
          ) : (
            <p className="rounded-container border-(length:--border-w) bg-card p-card text-sm text-muted-foreground shadow-hairline">
              {t("menu.editor.savedFirst")}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** One label/value line in the view-only item detail. */
function ReadOnlyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-sm leading-5 text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-5">{children}</dd>
    </div>
  );
}

/**
 * View-only item detail (bead legend-5a74): a visitor with menu.item.view but
 * not menu.item.manage sees the content, photo and state, and no write control.
 */
function ReadOnlyItemDetail({
  item,
  categories,
  stations,
}: {
  item: MenuItemAdmin;
  categories: { id: string; name: string }[];
  stations: { id: string; name: string }[];
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/kelola/menu" aria-label={t("menu.list.title")}>
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h2 className="truncate type-title">{item.name}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {categories.find((entry) => entry.id === item.categoryId)?.name ??
              t("menu.list.noCategory")}
          </p>
        </div>
      </div>

      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content" className="max-md:min-h-11">
            {t("menu.editor.sections.content")}
          </TabsTrigger>
          <TabsTrigger value="variants" className="max-md:min-h-11">
            {t("menu.editor.sections.variants")}
          </TabsTrigger>
          <TabsTrigger value="modifiers" className="max-md:min-h-11">
            {t("menu.editor.sections.modifiers")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="content">
          <ReadOnlyItemContent
            item={item}
            categories={categories}
            stations={stations}
          />
        </TabsContent>
        <TabsContent value="variants">
          <VariantSection itemId={item.id} />
        </TabsContent>
        <TabsContent value="modifiers">
          <ModifierSection itemId={item.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * View-only content tab (bead legend-5a74): a visitor with menu.item.view but
 * not menu.item.manage sees the content, photo and state, and no write control.
 */
function ReadOnlyItemContent({
  item,
  categories,
  stations,
}: {
  item: MenuItemAdmin;
  categories: { id: string; name: string }[];
  stations: { id: string; name: string }[];
}) {
  const t = useT();
  const category = categories.find((entry) => entry.id === item.categoryId);
  const station = stations.find((entry) => entry.id === item.stationId);
  const course = item.course as (typeof COURSES)[number] | null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <CardShell>
        <Card className="gap-4">
          <dl className="grid gap-4">
            <ReadOnlyRow label={t("menu.editor.fields.name")}>
              <span className="font-medium">{item.name}</span>
            </ReadOnlyRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <ReadOnlyRow label={t("menu.editor.fields.category")}>
                {category?.name ?? t("menu.list.noCategory")}
              </ReadOnlyRow>
              <ReadOnlyRow label={t("menu.editor.fields.type")}>
                {t(
                  item.type === "combo"
                    ? "menu.editor.type.combo"
                    : "menu.editor.type.single",
                )}
              </ReadOnlyRow>
            </div>
            <ReadOnlyRow label={t("menu.editor.fields.description")}>
              {item.description || "—"}
            </ReadOnlyRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <ReadOnlyRow label={t("menu.editor.fields.stationType")}>
                {item.stationType
                  ? t(`menu.stations.types.${item.stationType}`)
                  : "—"}
              </ReadOnlyRow>
              <ReadOnlyRow label={t("menu.editor.fields.station")}>
                {station?.name ?? t("menu.list.noStation")}
              </ReadOnlyRow>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ReadOnlyRow label={t("menu.editor.fields.course")}>
                {course && COURSES.includes(course)
                  ? t(`menu.editor.course.${course}`)
                  : (item.course ?? t("menu.editor.course.none"))}
              </ReadOnlyRow>
            </div>
            <ReadOnlyRow label={t("menu.editor.fields.labels")}>
              {item.labels.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {item.labels.map((label) => (
                    <Badge key={label} tone="info">
                      {label in LABEL_KEYS
                        ? t(LABEL_KEYS[label as keyof typeof LABEL_KEYS])
                        : label}
                    </Badge>
                  ))}
                </span>
              )}
            </ReadOnlyRow>
            <ReadOnlyRow label={t("menu.editor.fields.allergens")}>
              {item.allergens.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {item.allergens.map((allergen) => (
                    <Badge key={allergen} tone="neutral">
                      {allergen in ALLERGEN_KEYS
                        ? t(
                            ALLERGEN_KEYS[
                              allergen as keyof typeof ALLERGEN_KEYS
                            ],
                          )
                        : allergen}
                    </Badge>
                  ))}
                </span>
              )}
            </ReadOnlyRow>
          </dl>
        </Card>
      </CardShell>

      <CardShell className="self-start">
        <Card className="gap-4">
          <div className="grid gap-1.5">
            <span className="text-sm font-semibold">
              {t("menu.editor.fields.photo")}
            </span>
            <MediaPlate
              src={item.mediaUrl}
              alt={item.name}
              ratio="thumb"
              missing="required"
              className="w-24"
            />
          </div>
          <div className="grid gap-1.5 border-t pt-4">
            <span className="text-sm font-semibold">
              {t("menu.editor.fields.active")}
            </span>
            <Badge tone={item.isActive ? "success" : "neutral"}>
              {t(
                item.isActive
                  ? "menu.list.status.available"
                  : "menu.list.status.inactive",
              )}
            </Badge>
          </div>
        </Card>
      </CardShell>
    </div>
  );
}
