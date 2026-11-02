import * as React from "react";
import { ClipboardList, FilePlus2 } from "lucide-react";
import {
  createPurchaseOrderInputSchema,
  createPurchaseRequestInputSchema,
  type InventoryItem,
  type PurchaseOrder,
  type PurchaseRequest,
  type Supplier,
  type Uom,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreatePurchaseOrder,
  useCreatePurchaseRequest,
  useInventoryItems,
  useOutlets,
  usePurchaseOrder,
  usePurchaseOrders,
  usePurchaseRequest,
  usePurchaseRequests,
  useSendPurchaseOrder,
  useSuppliers,
  useTransitionPurchaseOrder,
  useTransitionPurchaseRequest,
  useUoms,
} from "../hooks";

const statusKeys = {
  draft: "purchasing.status.draft",
  pending_approval: "purchasing.status.pending_approval",
  approved: "purchasing.status.approved",
  rejected: "purchasing.status.rejected",
  converted: "purchasing.status.converted",
  cancelled: "purchasing.status.cancelled",
  sent: "purchasing.status.sent",
  partially_received: "purchasing.status.partially_received",
  received: "purchasing.status.received",
  closed: "purchasing.status.closed",
} as const;
function Status({ value }: { value: keyof typeof statusKeys }) {
  const t = useT();
  const kind =
    value === "rejected" || value === "cancelled"
      ? "danger"
      : value === "pending_approval"
        ? "warning"
        : value === "draft"
          ? "info"
          : "success";
  return <StatusPill status={kind}>{t(statusKeys[value])}</StatusPill>;
}
function ItemSelect({
  items,
  value,
  onChange,
  ...triggerProps
}: {
  items: InventoryItem[];
  value: string;
  onChange: (v: string) => void;
} & Omit<React.ComponentPropsWithoutRef<"button">, "onChange" | "value">) {
  const t = useT();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger {...triggerProps}>
        <SelectValue placeholder={t("purchasing.selectItem")} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RequestForm({
  outletId,
  items,
  onDone,
  onCancel,
}: {
  outletId: string;
  items: InventoryItem[];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const create = useCreatePurchaseRequest();
  const [itemId, setItemId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [neededBy, setNeededBy] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const item = items.find((row) => row.id === itemId);
    const result = createPurchaseRequestInputSchema.safeParse({
      outletId,
      neededBy,
      lines: [{ inventoryItemId: itemId, quantity, uomId: item?.baseUomId }],
      note: note || null,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.success) {
      setError(true);
      return;
    }
    try {
      const response = await create.mutateAsync(result.data);
      onDone(response.data.request.id);
    } catch {
      setError(true);
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">{t("purchasing.requestForm")}</h2>
      <form onSubmit={submit} className="grid gap-4">
        <FormField label={t("purchasing.item")} required>
          <ItemSelect items={items} value={itemId} onChange={setItemId} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t("purchasing.quantity")} required>
            <Input
              type="number"
              min="0.0001"
              step="0.0001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </FormField>
          <FormField label={t("purchasing.neededBy")} required>
            <Input
              type="date"
              value={neededBy}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label={t("purchasing.note")}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error && (
          <p role="alert" className="text-danger">
            {t("purchasing.invalid")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={create.isPending}>
            {t("purchasing.saveRequest")}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function RequestDetail({
  id,
  items,
  uoms,
  onCreateOrder,
}: {
  id: string;
  items: InventoryItem[];
  uoms: Uom[];
  onCreateOrder: () => void;
}) {
  const t = useT();
  const query = usePurchaseRequest(id);
  const transition = useTransitionPurchaseRequest();
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState(false);
  if (query.isPending) return <Skeleton className="h-32" />;
  if (query.isError || !query.data)
    return <ErrorState onRetry={() => void query.refetch()} />;
  const { request, lines } = query.data.data;
  async function act(action: "submit" | "approve" | "reject") {
    try {
      setError(false);
      await transition.mutateAsync({
        id,
        body: {
          action,
          note: note || null,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } catch {
      setError(true);
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {t("purchasing.requestDetail")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("purchasing.neededBy")}: <time>{request.neededBy}</time>
          </p>
        </div>
        <Status value={request.status} />
      </div>
      <ul className="divide-y">
        {lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-4 py-3">
            <span>
              {items.find((item) => item.id === line.inventoryItemId)?.name ??
                line.inventoryItemId}
            </span>
            <span className="tabular">
              {line.quantity}{" "}
              {uoms.find((unit) => unit.id === line.uomId)?.code}
            </span>
          </li>
        ))}
      </ul>
      {request.note && (
        <p className="text-sm text-muted-foreground">{request.note}</p>
      )}
      {request.status === "pending_approval" && (
        <FormField label={t("purchasing.reason")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {t("purchasing.actionError")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {request.status === "draft" && (
          <Button
            onClick={() => void act("submit")}
            loading={transition.isPending}
          >
            {t("purchasing.submit")}
          </Button>
        )}
        {request.status === "pending_approval" && (
          <>
            <Button
              onClick={() => void act("approve")}
              loading={transition.isPending}
            >
              {t("purchasing.approve")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void act("reject")}
              disabled={!note || transition.isPending}
            >
              {t("purchasing.reject")}
            </Button>
          </>
        )}
        {request.status === "approved" && (
          <Button onClick={onCreateOrder}>{t("purchasing.createOrder")}</Button>
        )}
      </div>
    </Card>
  );
}

function OrderForm({
  outletId,
  requestId,
  suppliers,
  items,
  onDone,
  onCancel,
}: {
  outletId: string;
  requestId: string;
  suppliers: Supplier[];
  items: InventoryItem[];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const request = usePurchaseRequest(requestId);
  const create = useCreatePurchaseOrder();
  const [supplierId, setSupplierId] = React.useState("");
  const [expectedDate, setExpectedDate] = React.useState("");
  const [prices, setPrices] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState(false);
  if (request.isPending) return <Skeleton className="h-32" />;
  if (request.isError || !request.data)
    return <ErrorState onRetry={() => void request.refetch()} />;
  const lines = request.data.data.lines;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = createPurchaseOrderInputSchema.safeParse({
      outletId,
      supplierId,
      purchaseRequestId: requestId,
      expectedDate,
      source: "user",
      lines: lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        uomId: line.uomId,
        unitPriceIdr: prices[line.id] ?? "",
      })),
      idempotencyKey: crypto.randomUUID(),
    });
    if (!parsed.success) {
      setError(true);
      return;
    }
    try {
      const response = await create.mutateAsync(parsed.data);
      onDone(response.data.purchaseOrder.id);
    } catch {
      setError(true);
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">{t("purchasing.orderForm")}</h2>
      <form onSubmit={submit} className="grid gap-4">
        <FormField label={t("purchasing.supplier")} required>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger aria-label={t("purchasing.supplier")}>
              <SelectValue placeholder={t("purchasing.chooseSupplier")} />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t("purchasing.expectedDate")} required>
          <Input
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </FormField>
        {lines.map((line) => (
          <FormField
            key={line.id}
            label={`${items.find((item) => item.id === line.inventoryItemId)?.name ?? line.inventoryItemId} · ${t("purchasing.unitPrice")}`}
            required
          >
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={prices[line.id] ?? ""}
              onChange={(e) =>
                setPrices({ ...prices, [line.id]: e.target.value })
              }
            />
          </FormField>
        ))}
        {error && (
          <p role="alert" className="text-danger">
            {t("purchasing.invalid")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={create.isPending}>
            {t("purchasing.saveOrder")}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OrderDetail({
  id,
  items,
  suppliers,
  uoms,
}: {
  id: string;
  items: InventoryItem[];
  suppliers: Supplier[];
  uoms: Uom[];
}) {
  const t = useT();
  const query = usePurchaseOrder(id);
  const transition = useTransitionPurchaseOrder();
  const send = useSendPurchaseOrder();
  const [email, setEmail] = React.useState("");
  const [note, setNote] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState(false);
  if (query.isPending) return <Skeleton className="h-32" />;
  if (query.isError || !query.data)
    return <ErrorState onRetry={() => void query.refetch()} />;
  const { purchaseOrder: order, lines } = query.data.data;
  async function act(action: "submit" | "approve" | "reject") {
    try {
      setError(false);
      await transition.mutateAsync({
        id,
        body: {
          action,
          note: note || null,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } catch {
      setError(true);
    }
  }
  async function sendOrder(channel: "email" | "share_link") {
    try {
      setError(false);
      const result = await send.mutateAsync({
        id,
        body: {
          channel,
          ...(channel === "email" ? { email } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
      });
      setUrl(result.data.shareUrl ?? "");
    } catch {
      setError(true);
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{order.number}</h2>
          <p className="text-sm text-muted-foreground">
            {suppliers.find((s) => s.id === order.supplierId)?.name} ·{" "}
            {order.expectedDate}
          </p>
        </div>
        <Status value={order.status} />
      </div>
      <ul className="divide-y">
        {lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-4 py-3">
            <span>
              {items.find((item) => item.id === line.inventoryItemId)?.name ??
                line.inventoryItemId}
              <span className="block text-sm text-muted-foreground tabular">
                {line.quantity}{" "}
                {uoms.find((unit) => unit.id === line.uomId)?.code}
              </span>
            </span>
            <Money amount={line.lineTotalIdr} />
          </li>
        ))}
      </ul>
      <dl className="grid gap-2 border-t pt-4">
        <div className="flex justify-between">
          <dt>{t("purchasing.subtotal")}</dt>
          <dd>
            <Money amount={order.subtotalIdr} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>{t("purchasing.tax")}</dt>
          <dd>
            <Money amount={order.taxIdr} />
          </dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt>{t("purchasing.total")}</dt>
          <dd>
            <Money amount={order.totalIdr} />
          </dd>
        </div>
      </dl>
      {order.status === "pending_approval" && (
        <FormField label={t("purchasing.reason")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      )}
      {(order.status === "approved" || order.status === "sent") && (
        <FormField label={t("purchasing.email")}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {t("purchasing.actionError")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {order.status === "draft" && (
          <Button
            onClick={() => void act("submit")}
            loading={transition.isPending}
          >
            {t("purchasing.submit")}
          </Button>
        )}
        {order.status === "pending_approval" && (
          <>
            <Button
              onClick={() => void act("approve")}
              loading={transition.isPending}
            >
              {t("purchasing.approve")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void act("reject")}
              disabled={!note || transition.isPending}
            >
              {t("purchasing.reject")}
            </Button>
          </>
        )}
        {(order.status === "approved" || order.status === "sent") && (
          <>
            <Button
              onClick={() => void sendOrder("share_link")}
              loading={send.isPending}
            >
              {t("purchasing.share")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void sendOrder("email")}
              disabled={!email || send.isPending}
            >
              {t("purchasing.sendEmail")}
            </Button>
          </>
        )}
      </div>
      {url && (
        <div className="grid gap-2">
          {import.meta.env.VITE_API_MOCK === "true" && (
            <p className="text-sm text-muted-foreground">
              {t("purchasing.mockLink")}
            </p>
          )}
          <FormField label={t("purchasing.shareLink")}>
            <Input readOnly value={url} />
          </FormField>
          {import.meta.env.VITE_API_MOCK !== "true" && (
            <Button asChild variant="outline">
              <a href={url} target="_blank" rel="noreferrer">
                {t("purchasing.preview")}
              </a>
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function PurchasingPage() {
  const t = useT();
  const outlets = useOutlets();
  const outletId = outlets.data?.data[0]?.id ?? "";
  const requests = usePurchaseRequests(outletId);
  const orders = usePurchaseOrders(outletId);
  const items = useInventoryItems();
  const suppliers = useSuppliers();
  const uoms = useUoms();
  const [view, setView] = React.useState<
    "list" | "new" | "request" | "order" | "newOrder"
  >("list");
  const [selected, setSelected] = React.useState("");
  const loading =
    outlets.isPending ||
    (Boolean(outletId) && (requests.isPending || orders.isPending)) ||
    items.isPending ||
    suppliers.isPending ||
    uoms.isPending;
  const failed =
    outlets.isError ||
    requests.isError ||
    orders.isError ||
    items.isError ||
    suppliers.isError ||
    uoms.isError;
  const retry = () => {
    void Promise.all([
      outlets.refetch(),
      requests.refetch(),
      orders.refetch(),
      items.refetch(),
      suppliers.refetch(),
      uoms.refetch(),
    ]);
  };
  const itemRows = items.data?.data ?? [];
  const supplierRows = suppliers.data?.data ?? [];
  const units = uoms.data?.data ?? [];
  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("purchasing.title")}</h1>
          <p className="mt-1 text-muted-foreground">
            {t("purchasing.subtitle")}
          </p>
        </div>
        {view === "list" && (
          <Button onClick={() => setView("new")}>
            <FilePlus2 aria-hidden="true" />
            {t("purchasing.newRequest")}
          </Button>
        )}
      </header>
      {loading ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
        </div>
      ) : failed ? (
        <ErrorState
          description={
            typeof navigator !== "undefined" && !navigator.onLine
              ? t("purchasing.offline")
              : undefined
          }
          onRetry={retry}
        />
      ) : !outletId ? (
        <EmptyState
          title={t("purchasing.noOutlet")}
          description={t("purchasing.noOutletHint")}
        />
      ) : view === "new" ? (
        <RequestForm
          outletId={outletId}
          items={itemRows}
          onCancel={() => setView("list")}
          onDone={(id) => {
            setSelected(id);
            setView("request");
          }}
        />
      ) : view === "request" ? (
        <>
          <Button
            className="w-fit"
            variant="ghost"
            onClick={() => setView("list")}
          >
            {t("common.back")}
          </Button>
          <RequestDetail
            id={selected}
            items={itemRows}
            uoms={units}
            onCreateOrder={() => setView("newOrder")}
          />
        </>
      ) : view === "newOrder" ? (
        <OrderForm
          outletId={outletId}
          requestId={selected}
          suppliers={supplierRows}
          items={itemRows}
          onCancel={() => setView("request")}
          onDone={(id) => {
            setSelected(id);
            setView("order");
          }}
        />
      ) : view === "order" ? (
        <>
          <Button
            className="w-fit"
            variant="ghost"
            onClick={() => setView("list")}
          >
            {t("common.back")}
          </Button>
          <OrderDetail
            id={selected}
            items={itemRows}
            suppliers={supplierRows}
            uoms={units}
          />
        </>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <DocumentList
            title={t("purchasing.requestList")}
            empty={t("purchasing.noRequests")}
            rows={requests.data?.data ?? []}
            onSelect={(id) => {
              setSelected(id);
              setView("request");
            }}
          />
          <DocumentList
            title={t("purchasing.orderList")}
            empty={t("purchasing.noOrders")}
            rows={orders.data?.data ?? []}
            onSelect={(id) => {
              setSelected(id);
              setView("order");
            }}
          />
        </div>
      )}
    </main>
  );
}
function DocumentList({
  title,
  empty,
  rows,
  onSelect,
}: {
  title: string;
  empty: string;
  rows: (PurchaseRequest | PurchaseOrder)[];
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-4">
        <ClipboardList
          className="size-5 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="font-semibold">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={empty} description={t("purchasing.emptyHint")} />
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onSelect(row.id)}
                className="flex min-h-16 w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              >
                <span>
                  <span className="block font-semibold">
                    {"number" in row ? row.number : row.neededBy}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {"number" in row
                      ? row.expectedDate
                      : t("purchasing.neededBy")}
                  </span>
                </span>
                <Status value={row.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
