// "Produk" tab: the facility product catalog (single ticket, menu-package
// component, subscription product) plus the five entitlement sources the PRD
// lists under "Produk & Hak Akses" (PRD v1.7 §3 F25). Source counts are derived
// from the configured products, rules and plans; they never invent a source.
import * as React from "react";
import type {
  FacilityConfig,
  FacilityProduct,
  FacilityProductType,
} from "@starter/shared/facility";
import {
  createFacilityProductSchema,
  updateFacilityProductSchema,
} from "@starter/shared/facility";
import type { MenuItemAdmin } from "@starter/shared/menu";
import { Lock } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { useCreateProduct, useUpdateProduct } from "../hooks.ts";
import {
  menuItemLabel,
  parseCreateDraft,
  parseInteger,
  parseUpdateDraft,
  productTypeLabel,
  shortId,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

const PRODUCT_TYPES: readonly FacilityProductType[] = [
  "single",
  "package_component",
  "subscription_plan",
];

export type ConfigTabKey =
  | "general"
  | "areas"
  | "products"
  | "entitlements"
  | "addons"
  | "subscriptions"
  | "wifi";

type ProductDialogState =
  { mode: "create" } | { mode: "edit"; product: FacilityProduct } | null;

export function ProductsTab({
  facilityId,
  config,
  menuItems,
  onOpenTab,
}: {
  facilityId: string;
  config: FacilityConfig;
  menuItems: readonly MenuItemAdmin[];
  onOpenTab: (tab: ConfigTabKey) => void;
}) {
  const t = useT();
  const toast = useToast();
  const updateProduct = useUpdateProduct(facilityId);
  const [dialog, setDialog] = React.useState<ProductDialogState>(null);

  const products = [...config.products]
    .filter((product) => product.facilityId === facilityId)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  const combos = menuItems.filter((item) => item.type === "combo");
  const purchaseCount = products.filter(
    (product) => product.type === "single",
  ).length;
  const packageCount = products.filter(
    (product) => product.type === "package_component",
  ).length;
  const minSpendRules = config.entitlementRules.filter(
    (rule) => rule.type === "min_spend",
  ).length;
  const tierRules = config.entitlementRules.filter(
    (rule) => rule.type === "tier_benefit",
  ).length;
  const plans = config.subscriptionPlans.filter(
    (plan) => plan.facilityId === facilityId,
  ).length;

  function toggle(product: FacilityProduct, isActive: boolean) {
    updateProduct.mutate(
      {
        productId: product.id,
        body: { isActive },
        expectedUpdatedAt: product.updatedAt,
      },
      {
        onSuccess: () =>
          toast({
            title: t("facilityAdmin.products.updated"),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityAdmin.products.updateFailed"),
            description: error instanceof ApiError ? error.message : undefined,
            tone: "danger",
          }),
      },
    );
  }

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-products"
        title={t("facilityAdmin.products.title")}
        description={t("facilityAdmin.products.description")}
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => setDialog({ mode: "create" })}
          >
            {t("facilityAdmin.products.add")}
          </Button>
        }
      >
        {products.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.products.empty")}
            description={t("facilityAdmin.products.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("facilityAdmin.products.columnsName")}</TableHead>
                <TableHead>{t("facilityAdmin.products.columnsType")}</TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.products.columnsPrice")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.products.columnsSessions")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.products.columnsMaxPerDay")}
                </TableHead>
                <TableHead>
                  {t("facilityAdmin.products.columnsMenuItem")}
                </TableHead>
                <TableHead>
                  {t("facilityAdmin.products.columnsStatus")}
                </TableHead>
                <TableHead className="text-right">
                  {t("facilityAdmin.products.columnsActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow
                  key={product.id}
                  data-slot="facility-product"
                  data-product-id={product.id}
                >
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">
                      {t(productTypeLabel[product.type])}
                    </Badge>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={product.priceIdr} />
                  </TableCell>
                  <TableCell numeric>{product.sessions}</TableCell>
                  <TableCell numeric>
                    {product.maxPerDay === null
                      ? t("facilityAdmin.common.unlimited")
                      : product.maxPerDay}
                  </TableCell>
                  <TableCell>
                    {product.menuItemId === null ? (
                      <span className="text-muted-foreground">
                        {t("facilityAdmin.products.noMenuPackage")}
                      </span>
                    ) : (
                      menuItemLabel(combos, product.menuItemId, t)
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={product.isActive}
                      disabled={updateProduct.isPending}
                      aria-label={t(
                        product.isActive
                          ? "facilityAdmin.products.disable"
                          : "facilityAdmin.products.enable",
                        { name: product.name },
                      )}
                      onCheckedChange={(checked) => toggle(product, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("facilityAdmin.products.edit", {
                          name: product.name,
                        })}
                        onClick={() => setDialog({ mode: "edit", product })}
                      >
                        {t("facilityAdmin.common.edit")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ConfigSection>

      <ConfigSection
        slot="entitlement-sources"
        title={t("facilityAdmin.sources.title")}
        description={t("facilityAdmin.sources.description")}
      >
        <div className="grid gap-3">
          <SourceRow
            title={t("facilityAdmin.sources.purchase")}
            hint={t("facilityAdmin.sources.purchaseHint")}
            count={purchaseCount}
            countLabel={t("facilityAdmin.sources.countProducts", {
              count: purchaseCount,
            })}
          />
          <SourceRow
            title={t("facilityAdmin.sources.package")}
            hint={t("facilityAdmin.sources.packageHint")}
            count={packageCount}
            countLabel={t("facilityAdmin.sources.countProducts", {
              count: packageCount,
            })}
          />
          <SourceRow
            title={t("facilityAdmin.sources.min_spend")}
            hint={t("facilityAdmin.sources.minSpendHint")}
            count={minSpendRules}
            countLabel={t("facilityAdmin.sources.countRules", {
              count: minSpendRules,
            })}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenTab("entitlements")}
              >
                {t("facilityAdmin.sources.manageEntitlements")}
              </Button>
            }
          />
          <SourceRow
            title={t("facilityAdmin.sources.tier_benefit")}
            hint={t("facilityAdmin.sources.tierBenefitHint")}
            count={tierRules}
            countLabel={t("facilityAdmin.sources.countRules", {
              count: tierRules,
            })}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenTab("entitlements")}
              >
                {t("facilityAdmin.sources.manageEntitlements")}
              </Button>
            }
          />
          <SourceRow
            title={t("facilityAdmin.sources.subscription")}
            hint={t("facilityAdmin.sources.subscriptionHint")}
            count={plans}
            countLabel={t("facilityAdmin.sources.countPlans", {
              count: plans,
            })}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenTab("subscriptions")}
              >
                {t("facilityAdmin.sources.manageSubscriptions")}
              </Button>
            }
          />
        </div>
      </ConfigSection>

      {dialog && (
        <ProductDialog
          key={dialog.mode === "edit" ? dialog.product.id : "new-product"}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          facilityId={facilityId}
          product={dialog.mode === "edit" ? dialog.product : null}
          combos={combos}
        />
      )}
    </div>
  );
}

function SourceRow({
  title,
  hint,
  count,
  countLabel,
  action,
}: {
  title: string;
  hint: string;
  count: number;
  countLabel: string;
  action?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div
      data-slot="entitlement-source"
      className="flex flex-wrap items-center justify-between gap-3 rounded-container border-(length:--border-w) border-border p-3"
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={count > 0 ? "success" : "neutral"}>
          {count > 0 ? countLabel : t("facilityAdmin.sources.notConfigured")}
        </Badge>
        {action}
      </div>
    </div>
  );
}

function ProductDialog({
  open,
  onOpenChange,
  facilityId,
  product,
  combos,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  product: FacilityProduct | null;
  combos: readonly MenuItemAdmin[];
}) {
  const t = useT();
  const toast = useToast();
  const createProduct = useCreateProduct(facilityId);
  const updateProduct = useUpdateProduct(facilityId);
  const [name, setName] = React.useState(product?.name ?? "");
  const [type, setType] = React.useState<FacilityProductType>(
    product?.type ?? "single",
  );
  const [price, setPrice] = React.useState(
    product ? String(product.priceIdr) : "",
  );
  const [sessions, setSessions] = React.useState(
    product ? String(product.sessions) : "1",
  );
  const [maxPerDay, setMaxPerDay] = React.useState(
    product?.maxPerDay === null || product?.maxPerDay === undefined
      ? ""
      : String(product.maxPerDay),
  );
  const [menuItemId, setMenuItemId] = React.useState(
    product?.menuItemId ?? "none",
  );
  const [isActive, setIsActive] = React.useState(product?.isActive ?? true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();
  const pending = createProduct.isPending || updateProduct.isPending;

  const knownMenuIds = new Set(combos.map((item) => item.id));
  const menuChoices: { id: string; name: string }[] = combos.map((item) => ({
    id: item.id,
    name: item.name,
  }));
  if (menuItemId !== "none" && !knownMenuIds.has(menuItemId)) {
    // A fixture may reference a package the menu fixtures no longer carry; the
    // current value stays selectable instead of silently changing the row.
    menuChoices.push({
      id: menuItemId,
      name: t("facilityAdmin.products.menuFallback", {
        id: shortId(menuItemId),
      }),
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = name.trim();
    if (trimmed.length === 0)
      next.name = t("facilityAdmin.products.errorsNameRequired");
    else if (trimmed.length > 150)
      next.name = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.products.fieldsName"),
        max: 150,
      });
    const priceIdr = parseInteger(price);
    if (priceIdr === null)
      next.priceIdr = t("facilityAdmin.products.errorsPriceInvalid");
    const sessionCount = parseInteger(sessions);
    if (sessionCount === null || sessionCount < 1 || sessionCount > 100)
      next.sessions = t("facilityAdmin.products.errorsSessionsInvalid");
    const maxParsed = maxPerDay.trim() === "" ? null : parseInteger(maxPerDay);
    if (
      maxPerDay.trim() !== "" &&
      (maxParsed === null || maxParsed < 1 || maxParsed > 10)
    )
      next.maxPerDay = t("facilityAdmin.products.errorsMaxPerDayInvalid");

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);
    if (priceIdr === null || sessionCount === null) return;

    if (product) {
      const parsed = parseUpdateDraft(updateFacilityProductSchema, {
        name: trimmed,
        priceIdr,
        sessions: sessionCount,
        maxPerDay: maxParsed,
        menuItemId: menuItemId === "none" ? null : menuItemId,
        isActive,
      });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        setFormError(
          t("form.errorSummary", { count: parsed.error.issues.length }),
        );
        return;
      }
      updateProduct.mutate(
        {
          productId: product.id,
          body: parsed.data,
          expectedUpdatedAt: product.updatedAt,
        },
        {
          onSuccess: () => {
            toast({
              title: t("facilityAdmin.products.updated"),
              tone: "success",
            });
            onOpenChange(false);
          },
          onError: (error) =>
            setFormError(
              error instanceof ApiError
                ? error.message
                : t("facilityAdmin.products.updateFailed"),
            ),
        },
      );
      return;
    }

    const parsed = parseCreateDraft(createFacilityProductSchema, {
      facilityId,
      name: trimmed,
      type,
      priceIdr,
      sessions: sessionCount,
      maxPerDay: maxParsed,
      menuItemId: menuItemId === "none" ? null : menuItemId,
      isActive,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    createProduct.mutate(parsed.data, {
      onSuccess: () => {
        toast({ title: t("facilityAdmin.products.created"), tone: "success" });
        onOpenChange(false);
      },
      onError: (error) =>
        setFormError(
          error instanceof ApiError
            ? error.message
            : t("facilityAdmin.products.createFailed"),
        ),
    });
  }

  return (
    <PendingDialog pending={pending} open={open} onOpenChange={onOpenChange}>
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {product
              ? t("facilityAdmin.products.editTitle")
              : t("facilityAdmin.products.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {product
              ? t("facilityAdmin.products.editHint")
              : t("facilityAdmin.products.createHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField
            label={t("facilityAdmin.products.fieldsName")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          {product ? (
            <div className="grid gap-1.5">
              <span className="text-sm font-semibold">
                {t("facilityAdmin.products.fieldsType")}
              </span>
              <p className="flex min-h-control-sm items-center gap-2 rounded-field border border-input bg-muted px-3 text-sm">
                <Lock
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                {t(productTypeLabel[product.type])}
              </p>
            </div>
          ) : (
            <FormField label={t("facilityAdmin.products.fieldsType")} required>
              <Select
                value={type}
                onValueChange={(value) => setType(value as FacilityProductType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map((productType) => (
                    <SelectItem key={productType} value={productType}>
                      {t(productTypeLabel[productType])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label={t("facilityAdmin.products.fieldsPrice")}
              hint={t("facilityAdmin.common.priceExclTaxHint")}
              error={errors.priceIdr}
              required
            >
              <Input
                inputMode="numeric"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.products.fieldsSessions")}
              error={errors.sessions}
              required
            >
              <Input
                inputMode="numeric"
                value={sessions}
                onChange={(event) => setSessions(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.products.fieldsMaxPerDay")}
              hint={t("facilityAdmin.products.fieldsMaxPerDayHint")}
              error={errors.maxPerDay}
            >
              <Input
                inputMode="numeric"
                value={maxPerDay}
                onChange={(event) => setMaxPerDay(event.target.value)}
              />
            </FormField>
          </div>
          <FormField
            label={t("facilityAdmin.products.fieldsMenuItem")}
            hint={t("facilityAdmin.products.fieldsMenuItemHint")}
          >
            <Select value={menuItemId} onValueChange={setMenuItemId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("facilityAdmin.products.menuNone")}
                </SelectItem>
                {menuChoices.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <Label htmlFor="facility-product-active">
                {t("facilityAdmin.products.fieldsActive")}
              </Label>
            </div>
            <Switch
              id="facility-product-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          </div>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              {t("facilityAdmin.products.save")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
