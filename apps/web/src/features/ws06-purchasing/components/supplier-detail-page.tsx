// /kelola/pengadaan/supplier/$supplierId — one supplier's profile, contacts,
// payment terms, catalog, price history and performance (PRD v1.7 §3 F18
// "Supplier"). Every section states loading, empty and error honestly; the
// performance metrics come from the contract report and are never invented.
import * as React from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import type {
  SupplierCatalogItem,
  SupplierDetail,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import { useInventoryItems, useUoms } from "../hooks";
import {
  useSupplierCatalog,
  useSupplierDetail,
  useSupplierPerformance,
  useSupplierPriceHistories,
} from "../supplier-hooks";
import {
  catalogItemIds,
  currentMonthRange,
  decimal4Idr,
  formatBpPercent,
  formatBusinessDate,
  formatDateTime,
  formatQuantity,
  latestCatalogRows,
  performanceIsEmpty,
  priceHistoryRows,
} from "../supplier-lib";
import { SupplierCatalogDialog } from "./supplier-catalog-dialog";
import { SupplierContactDialog } from "./supplier-contact-dialog";
import { SupplierFormDialog } from "./supplier-form-dialog";
import { SupplierActiveState, SupplierRating } from "./supplier-rating";

function Section({
  title,
  description,
  action,
  footer,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  return (
    <CardShell>
      <CardShellBody>
        <section aria-labelledby={headingId} className="grid min-w-0">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b p-card">
            <div className="min-w-0">
              <h3 id={headingId} className="type-title">
                {title}
              </h3>
              {description && (
                <p className="text-sm leading-5 text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            {action}
          </header>
          <div className="min-w-0">{children}</div>
        </section>
      </CardShellBody>
      {footer && <CardShellFooter>{footer}</CardShellFooter>}
    </CardShell>
  );
}

function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-2 p-card">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-row" />
      ))}
    </div>
  );
}

function EmptyValue() {
  const t = useT();
  return (
    <span className="text-muted-foreground">
      {t("inventorySuppliers.columns.noValue")}
    </span>
  );
}

function ProfileSection({
  detail,
  canManage,
  onEdit,
}: {
  detail: SupplierDetail;
  canManage: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const { supplier } = detail;
  const fields: { label: string; value: React.ReactNode }[] = [
    {
      label: t("inventorySuppliers.detail.legalName"),
      value: supplier.legalName ?? <EmptyValue />,
    },
    {
      label: t("inventorySuppliers.detail.contactName"),
      value: supplier.contactName ?? <EmptyValue />,
    },
    {
      label: t("inventorySuppliers.detail.phone"),
      value: supplier.phone ? (
        <span className="tabular">{supplier.phone}</span>
      ) : (
        <EmptyValue />
      ),
    },
    {
      label: t("inventorySuppliers.detail.email"),
      value: supplier.email ?? <EmptyValue />,
    },
    {
      label: t("inventorySuppliers.detail.address"),
      value: supplier.address ?? <EmptyValue />,
    },
    {
      label: t("inventorySuppliers.detail.paymentTerms"),
      value: t("inventorySuppliers.days", {
        days: supplier.paymentTermsDays,
      }),
    },
    {
      label: t("inventorySuppliers.detail.rating"),
      value: <SupplierRating rating={supplier.rating} />,
    },
    {
      label: t("inventorySuppliers.detail.status"),
      value: <SupplierActiveState active={supplier.isActive} />,
    },
  ];
  return (
    <Section
      title={t("inventorySuppliers.detail.profileTitle")}
      action={
        canManage ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            {t("inventorySuppliers.detail.edit")}
          </Button>
        ) : undefined
      }
      footer={
        <span className="tabular">
          {t("inventorySuppliers.detail.updatedAt")}:{" "}
          {formatDateTime(supplier.updatedAt)}
        </span>
      }
    >
      <dl className="grid gap-4 p-card sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.label} className="grid min-w-0 gap-0.5">
            <dt className="text-sm leading-5 text-muted-foreground">
              {field.label}
            </dt>
            <dd className="min-w-0 text-sm leading-5 font-medium break-words">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ContactsSection({
  supplierId,
  detail,
  canManage,
}: {
  supplierId: string;
  detail: SupplierDetail;
  canManage: boolean;
}) {
  const t = useT();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const contacts = detail.contacts;
  return (
    <>
      <Section
        title={t("inventorySuppliers.contacts.title")}
        description={t("inventorySuppliers.contacts.description")}
        action={
          canManage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              <Plus aria-hidden="true" />
              {t("inventorySuppliers.contacts.add")}
            </Button>
          ) : undefined
        }
      >
        {contacts.length === 0 ? (
          <EmptyState
            title={t("inventorySuppliers.contacts.emptyTitle")}
            description={t("inventorySuppliers.contacts.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventorySuppliers.contacts.columns.name")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.contacts.columns.role")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.contacts.columns.phone")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.contacts.columns.email")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.contacts.columns.primary")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">{contact.name}</TableCell>
                  <TableCell>{contact.role ?? <EmptyValue />}</TableCell>
                  <TableCell className="tabular">{contact.phone}</TableCell>
                  <TableCell>{contact.email ?? <EmptyValue />}</TableCell>
                  <TableCell>
                    {contact.isPrimary
                      ? t("inventorySuppliers.contacts.primaryYes")
                      : t("inventorySuppliers.contacts.primaryNo")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <SupplierContactDialog
        supplierId={supplierId}
        defaultPrimary={contacts.length === 0}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}

function TermsSection({ detail }: { detail: SupplierDetail }) {
  const t = useT();
  const { supplier } = detail;
  return (
    <Section
      title={t("inventorySuppliers.terms.title")}
      description={t("inventorySuppliers.terms.description")}
    >
      <dl className="grid gap-4 p-card sm:grid-cols-2">
        <div className="grid gap-0.5">
          <dt className="text-sm leading-5 text-muted-foreground">
            {t("inventorySuppliers.terms.paymentTerms")}
          </dt>
          <dd className="text-sm leading-5 font-medium">
            {t("inventorySuppliers.days", {
              days: supplier.paymentTermsDays,
            })}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-sm leading-5 text-muted-foreground">
            {t("inventorySuppliers.terms.rating")}
          </dt>
          <dd className="grid gap-1">
            <SupplierRating rating={supplier.rating} />
            <span className="text-sm leading-5 text-muted-foreground">
              {t("inventorySuppliers.terms.ratingHint")}
            </span>
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function CatalogSection({
  supplierId,
  catalog,
  loading,
  failed,
  onRetry,
  canManage,
}: {
  supplierId: string;
  catalog: readonly SupplierCatalogItem[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  canManage: boolean;
}) {
  const t = useT();
  const itemsQuery = useInventoryItems();
  const unitsQuery = useUoms();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const itemNames = React.useMemo(
    () => new Map<string, string>(items.map((item) => [item.id, item.name])),
    [items],
  );
  const itemName = (id: string) =>
    itemNames.get(id) ?? t("inventorySuppliers.catalog.itemUnknown");
  const unitCode = (id: string) =>
    units.find((unit) => unit.id === id)?.code ??
    t("inventorySuppliers.columns.noValue");
  const rows = React.useMemo(
    () =>
      latestCatalogRows(catalog).sort((left, right) =>
        (
          itemNames.get(left.inventoryItemId) ?? left.inventoryItemId
        ).localeCompare(
          itemNames.get(right.inventoryItemId) ?? right.inventoryItemId,
          "id-ID",
        ),
      ),
    [catalog, itemNames],
  );

  return (
    <>
      <Section
        title={t("inventorySuppliers.catalog.title")}
        description={t("inventorySuppliers.catalog.description")}
        action={
          canManage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              <Plus aria-hidden="true" />
              {t("inventorySuppliers.catalog.add")}
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <SectionSkeleton />
        ) : failed ? (
          <ErrorState
            title={t("inventorySuppliers.catalog.loadError")}
            onRetry={onRetry}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("inventorySuppliers.catalog.emptyTitle")}
            description={t("inventorySuppliers.catalog.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventorySuppliers.catalog.columns.item")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.catalog.columns.unit")}
                </TableHead>
                <TableHead numeric>
                  {t("inventorySuppliers.catalog.columns.price")}
                </TableHead>
                <TableHead>
                  {t("inventorySuppliers.catalog.columns.effectiveFrom")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {itemName(row.inventoryItemId)}
                  </TableCell>
                  <TableCell>{unitCode(row.purchaseUomId)}</TableCell>
                  <TableCell numeric>
                    <Money amount={decimal4Idr(row.priceIdr)} />
                  </TableCell>
                  <TableCell className="tabular">
                    {formatBusinessDate(row.effectiveFrom)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <SupplierCatalogDialog
        supplierId={supplierId}
        items={items}
        units={units}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}

function PriceHistorySection({
  histories,
  items,
  loading,
  failed,
  onRetry,
}: {
  histories: readonly (readonly SupplierCatalogItem[])[];
  items: readonly { id: string; name: string }[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const rows = React.useMemo(() => priceHistoryRows(histories), [histories]);
  const itemName = (id: string) =>
    items.find((item) => item.id === id)?.name ??
    t("inventorySuppliers.catalog.itemUnknown");
  const deltaText = (row: (typeof rows)[number]): string => {
    if (row.previous === null)
      return t("inventorySuppliers.priceHistory.initial");
    if (row.deltaBp === null) return t("inventorySuppliers.columns.noValue");
    if (row.deltaBp === 0)
      return t("inventorySuppliers.priceHistory.unchanged");
    // The catalog's own percent wrapper carries the "%" unit, so id-ID
    // formatting and the unit live in one place.
    const percent = t("inventorySuppliers.percent", {
      value: formatBpPercent(Math.abs(row.deltaBp)) ?? "",
    });
    return row.deltaBp > 0
      ? t("inventorySuppliers.priceHistory.increase", { percent })
      : t("inventorySuppliers.priceHistory.decrease", { percent });
  };
  return (
    <Section
      title={t("inventorySuppliers.priceHistory.title")}
      description={t("inventorySuppliers.priceHistory.description")}
    >
      {loading ? (
        <SectionSkeleton rows={4} />
      ) : failed ? (
        <ErrorState
          title={t("inventorySuppliers.priceHistory.loadError")}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t("inventorySuppliers.priceHistory.emptyTitle")}
          description={t("inventorySuppliers.priceHistory.emptyHint")}
        />
      ) : (
        <Table aria-label={t("inventorySuppliers.priceHistory.tableLabel")}>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("inventorySuppliers.priceHistory.columns.date")}
              </TableHead>
              <TableHead>
                {t("inventorySuppliers.priceHistory.columns.item")}
              </TableHead>
              <TableHead>
                {t("inventorySuppliers.priceHistory.columns.change")}
              </TableHead>
              <TableHead>
                {t("inventorySuppliers.priceHistory.columns.delta")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="tabular">
                  {formatBusinessDate(row.row.effectiveFrom)}
                </TableCell>
                <TableCell>{itemName(row.row.inventoryItemId)}</TableCell>
                <TableCell className="tabular">
                  {row.previous ? (
                    <>
                      <Money amount={decimal4Idr(row.previous.priceIdr)} />{" "}
                      <span aria-hidden="true">→</span>{" "}
                      <Money amount={decimal4Idr(row.row.priceIdr)} />
                    </>
                  ) : (
                    <Money amount={decimal4Idr(row.row.priceIdr)} />
                  )}
                </TableCell>
                <TableCell>{deltaText(row)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function PerformanceSection({
  supplierId,
  rating,
}: {
  supplierId: string;
  rating: number | null;
}) {
  const t = useT();
  const { fromDate, toDate } = currentMonthRange();
  const performanceQuery = useSupplierPerformance(supplierId, fromDate, toDate);
  const performance = performanceQuery.data?.data;
  const noValue = t("inventorySuppliers.performance.noValue");
  const percent = (bp: number | null) => {
    if (bp === null) return noValue;
    return t("inventorySuppliers.percent", {
      value: formatBpPercent(bp) ?? "",
    });
  };
  return (
    <Section
      title={t("inventorySuppliers.performance.title")}
      description={t("inventorySuppliers.performance.description")}
      footer={
        performance ? (
          <>
            <span>
              {t("inventorySuppliers.performance.period", {
                from: formatBusinessDate(performance.fromDate),
                to: formatBusinessDate(performance.toDate),
              })}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {t("inventorySuppliers.performance.computedAt", {
                date: formatBusinessDate(performance.computedAt.slice(0, 10)),
              })}
            </span>
          </>
        ) : undefined
      }
    >
      {performanceQuery.isPending ? (
        <SectionSkeleton rows={3} />
      ) : performanceQuery.isError || !performance ? (
        <ErrorState
          title={t("inventorySuppliers.performance.loadError")}
          onRetry={() => void performanceQuery.refetch()}
        />
      ) : performanceIsEmpty(performance) ? (
        <EmptyState
          title={t("inventorySuppliers.performance.emptyTitle")}
          description={t("inventorySuppliers.performance.emptyHint")}
        />
      ) : (
        <div className="grid gap-4 p-card">
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="grid min-w-0 gap-1">
              <dt className="type-eyebrow text-muted-foreground">
                {t("inventorySuppliers.performance.onTime")}
              </dt>
              <dd className="type-heading tabular">
                {percent(performance.onTimeRateBp)}
              </dd>
              <p className="text-xs leading-4 text-muted-foreground">
                {t("inventorySuppliers.performance.onTimeValue", {
                  onTime: performance.onTimeDeliveries,
                  total: performance.deliveriesTotal,
                })}
              </p>
            </div>
            <div className="grid min-w-0 gap-1">
              <dt className="type-eyebrow text-muted-foreground">
                {t("inventorySuppliers.performance.rejection")}
              </dt>
              <dd className="type-heading tabular">
                {percent(performance.rejectionRateBp)}
              </dd>
              <p className="text-xs leading-4 text-muted-foreground tabular">
                {t("inventorySuppliers.performance.rejectionValue", {
                  rejected: formatQuantity(performance.rejectedQty),
                  received: formatQuantity(performance.receivedQty),
                })}
              </p>
            </div>
            <div className="grid min-w-0 gap-1">
              <dt className="type-eyebrow text-muted-foreground">
                {t("inventorySuppliers.performance.priceVariance")}
              </dt>
              <dd className="type-heading tabular">
                {percent(performance.priceVarianceBp)}
              </dd>
            </div>
            <div className="grid min-w-0 gap-1">
              <dt className="type-eyebrow text-muted-foreground">
                {t("inventorySuppliers.performance.deliveries")}
              </dt>
              <dd className="type-heading tabular">
                <NumberDisplay value={performance.deliveriesTotal} />
              </dd>
              <p className="text-xs leading-4 text-muted-foreground">
                {t("inventorySuppliers.performance.deliveriesValue", {
                  count: performance.deliveriesTotal,
                })}
              </p>
            </div>
          </dl>
          <div className="grid gap-1 border-t pt-4">
            <span className="text-sm leading-5 font-medium">
              {t("inventorySuppliers.performance.rating")}
            </span>
            <SupplierRating rating={rating} />
            <span className="text-sm leading-5 text-muted-foreground">
              {t("inventorySuppliers.performance.ratingHint")}
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}

export function SupplierDetailPage({ supplierId }: { supplierId: string }) {
  const t = useT();
  const online = useOnline();
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  const canManage = holdsAny(access, ["purchasing.supplier.manage"]);
  const detailQuery = useSupplierDetail(supplierId);
  const catalogQuery = useSupplierCatalog(supplierId);
  const itemsQuery = useInventoryItems();
  const catalog = React.useMemo(
    () => catalogQuery.data?.data ?? [],
    [catalogQuery.data],
  );
  const itemIds = React.useMemo(() => catalogItemIds(catalog), [catalog]);
  const historyQueries = useSupplierPriceHistories(supplierId, itemIds);
  const [editOpen, setEditOpen] = React.useState(false);

  const back = (
    <Button asChild variant="ghost" className="w-fit">
      <Link
        to="/kelola/pengadaan/supplier"
        aria-label={t("inventorySuppliers.detail.back")}
      >
        <ArrowLeft aria-hidden="true" />
        {t("inventorySuppliers.detail.back")}
      </Link>
    </Button>
  );

  if (detailQuery.isPending)
    return (
      <div className="grid min-w-0 gap-5" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        {back}
        <Skeleton className="h-40 rounded-container" />
        <Skeleton className="h-64 rounded-container" />
        <Skeleton className="h-64 rounded-container" />
      </div>
    );

  if (detailQuery.isError || !detailQuery.data) {
    const error = detailQuery.error;
    if (error instanceof ApiError && error.status === 404)
      return (
        <div className="grid min-w-0 gap-5">
          {back}
          <CardShell>
            <CardShellBody>
              <EmptyState
                title={t("inventorySuppliers.detail.notFoundTitle")}
                description={t("inventorySuppliers.detail.notFoundHint")}
              />
            </CardShellBody>
          </CardShell>
        </div>
      );
    return (
      <div className="grid min-w-0 gap-5">
        {back}
        <CardShell>
          <CardShellBody>
            <ErrorState
              title={t("inventorySuppliers.detail.loadError")}
              description={
                online
                  ? t("inventorySuppliers.detail.loadErrorHint")
                  : t("inventorySuppliers.errors.offline")
              }
              onRetry={() => void detailQuery.refetch()}
            />
          </CardShellBody>
        </CardShell>
      </div>
    );
  }

  const detail = detailQuery.data.data;
  const items = itemsQuery.data?.data ?? [];
  const historyLoading =
    catalogQuery.isPending || historyQueries.some((query) => query.isPending);
  const historyFailed =
    catalogQuery.isError || historyQueries.some((query) => query.isError);
  const histories = historyQueries.map((query) => query.data?.data ?? []);

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid gap-2">
        {back}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="type-title break-words">{detail.supplier.name}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {detail.supplier.legalName ?? detail.supplier.name}
            </p>
          </div>
          <SupplierActiveState active={detail.supplier.isActive} />
        </div>
      </div>

      <ProfileSection
        detail={detail}
        canManage={canManage}
        onEdit={() => setEditOpen(true)}
      />
      <ContactsSection
        supplierId={supplierId}
        detail={detail}
        canManage={canManage}
      />
      <TermsSection detail={detail} />
      <CatalogSection
        supplierId={supplierId}
        catalog={catalog}
        loading={catalogQuery.isPending}
        failed={catalogQuery.isError}
        onRetry={() => void catalogQuery.refetch()}
        canManage={canManage}
      />
      <PriceHistorySection
        histories={histories}
        items={items}
        loading={historyLoading}
        failed={historyFailed}
        onRetry={() => {
          void catalogQuery.refetch();
          for (const query of historyQueries) void query.refetch();
        }}
      />
      <PerformanceSection
        supplierId={supplierId}
        rating={detail.supplier.rating}
      />

      <SupplierFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        supplier={detail.supplier}
      />
    </div>
  );
}
